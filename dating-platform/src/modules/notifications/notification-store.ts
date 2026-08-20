import { createHmac, randomUUID } from "node:crypto";

import { and, asc, eq, lte, or } from "drizzle-orm";

import { notificationInbox, notificationOutbox, notificationPreferences, users } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import { routeNotification, type NotificationChannel } from "./notification-router";

type NotificationDatabase = typeof productionDatabase;

const channels = (value: string[]): NotificationChannel[] => value.filter(
  (channel): channel is NotificationChannel => channel === "email" || channel === "sms" || channel === "inApp",
);

type InAppJob = { id: string; userId?: unknown; templateKey?: unknown; locale?: unknown; payload?: unknown };

export class DrizzleInAppNotificationProvider {
  private readonly database: NotificationDatabase;

  constructor(database: unknown) { this.database = database as NotificationDatabase; }

  async deliver(job: InAppJob, context: { idempotencyKey: string }) {
    if (typeof job.userId !== "string" || typeof job.templateKey !== "string"
      || (job.locale !== "en" && job.locale !== "zh-CN")) return { delivered: false };
    const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
      ? Object.fromEntries(Object.entries(job.payload).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string")) : {};
    await this.database.insert(notificationInbox).values({ userId: job.userId, outboxId: job.id,
      providerIdempotencyKey: context.idempotencyKey, templateKey: job.templateKey, locale: job.locale, payload })
      .onConflictDoNothing({ target: notificationInbox.providerIdempotencyKey });
    return { delivered: true };
  }
}

export class DrizzleNotificationStore {
  private readonly database: NotificationDatabase;

  constructor(database: unknown, private readonly options: { hmacKey: string; clock?: () => Date; leaseMs?: number }) {
    if (options.hmacKey.length < 32) throw new Error("NOTIFICATION_HMAC_KEY_INVALID");
    this.database = database as NotificationDatabase;
  }

  async claim() {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as NotificationDatabase;
      const now = (this.options.clock ?? (() => new Date()))();
      const candidates = await tx.select({ outbox: notificationOutbox, preference: notificationPreferences,
        email: users.email, phoneNumber: users.phoneNumber, phoneNumberVerified: users.phoneNumberVerified })
        .from(notificationOutbox).innerJoin(users, eq(users.id, notificationOutbox.userId))
        .leftJoin(notificationPreferences, eq(notificationPreferences.userId, notificationOutbox.userId))
        .where(or(and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.availableAt, now)),
          and(eq(notificationOutbox.status, "processing"), lte(notificationOutbox.leaseExpiresAt, now))))
        .orderBy(asc(notificationOutbox.availableAt), asc(notificationOutbox.id)).limit(20)
        .for("update", { of: notificationOutbox, skipLocked: true });
      for (const candidate of candidates) {
        if (candidate.outbox.attempts >= candidate.outbox.maxAttempts) {
          await tx.update(notificationOutbox).set({ status: "manual_review", manualReviewAt: now,
            lastErrorCode: "DELIVERY_FAILED", leaseId: null, leaseExpiresAt: null, updatedAt: now })
            .where(eq(notificationOutbox.id, candidate.outbox.id));
          continue;
        }
        const preference = candidate.preference;
        const route = routeNotification({ category: candidate.outbox.category as "security" | "transactional" | "marketing",
          preferredChannels: channels(candidate.outbox.channels), now, preferences: {
            locale: preference?.locale === "zh-CN" ? "zh-CN" : "en",
            timeZone: preference?.timeZone ?? "UTC",
            marketingEnabled: preference?.marketingEnabled ?? false,
            channelConsent: { email: preference?.emailEnabled ?? true, sms: preference?.smsEnabled ?? false,
              inApp: preference?.inAppEnabled ?? true },
            quietHours: preference?.quietStartHour === null || preference?.quietStartHour === undefined
              || preference.quietEndHour === null || preference.quietEndHour === undefined ? null
              : { startHour: preference.quietStartHour, endHour: preference.quietEndHour },
          } });
        if (route.status === "suppressed") {
          await tx.update(notificationOutbox).set({ status: "suppressed", leaseId: null, leaseExpiresAt: null,
            updatedAt: now }).where(eq(notificationOutbox.id, candidate.outbox.id));
          continue;
        }
        if (route.status === "deferred") {
          await tx.update(notificationOutbox).set({ status: "pending", availableAt: route.availableAt,
            leaseId: null, leaseExpiresAt: null, updatedAt: now }).where(eq(notificationOutbox.id, candidate.outbox.id));
          continue;
        }
        const deliverable = route.channels.filter((channel) => channel === "inApp"
          || (channel === "email" && Boolean(candidate.email))
          || (channel === "sms" && Boolean(candidate.phoneNumber && candidate.phoneNumberVerified)));
        if (deliverable.length === 0) {
          await tx.update(notificationOutbox).set({ status: "suppressed", leaseId: null, leaseExpiresAt: null,
            updatedAt: now }).where(eq(notificationOutbox.id, candidate.outbox.id));
          continue;
        }
        const leaseId = randomUUID();
        const attempts = candidate.outbox.attempts + 1;
        const [claimed] = await tx.update(notificationOutbox).set({ status: "processing", attempts, locale: route.locale,
          channels: deliverable, leaseId, leaseExpiresAt: new Date(now.getTime() + (this.options.leaseMs ?? 30_000)),
          updatedAt: now }).where(eq(notificationOutbox.id, candidate.outbox.id)).returning({ id: notificationOutbox.id });
        if (!claimed) continue;
        return { id: candidate.outbox.id, leaseId, userId: candidate.outbox.userId,
          category: candidate.outbox.category as "security" | "transactional" | "marketing",
          templateKey: candidate.outbox.templateKey, locale: route.locale, channels: deliverable,
          payload: candidate.outbox.payload,
          attempts, maxAttempts: candidate.outbox.maxAttempts,
          recipient: { email: deliverable.includes("email") ? candidate.email : null,
            sms: deliverable.includes("sms") && candidate.phoneNumberVerified ? candidate.phoneNumber : null },
          providerIdempotencyKey: createHmac("sha256", this.options.hmacKey)
            .update(`${candidate.outbox.id}:${candidate.outbox.dedupeKey}`).digest("base64url") };
      }
      return null;
    });
  }

  async complete(id: string, leaseId: string) {
    await this.database.update(notificationOutbox).set({ status: "sent", sentAt: this.options.clock?.() ?? new Date(),
      leaseId: null, leaseExpiresAt: null, lastErrorCode: null, updatedAt: this.options.clock?.() ?? new Date() })
      .where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.leaseId, leaseId),
        eq(notificationOutbox.status, "processing")));
  }

  async retry(id: string, leaseId: string, input: { errorCode: "DELIVERY_FAILED"; availableAt: Date }) {
    await this.database.update(notificationOutbox).set({ status: "pending", availableAt: input.availableAt,
      lastErrorCode: input.errorCode, leaseId: null, leaseExpiresAt: null, updatedAt: this.options.clock?.() ?? new Date() })
      .where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.leaseId, leaseId),
        eq(notificationOutbox.status, "processing")));
  }

  async manualReview(id: string, leaseId: string, errorCode: "DELIVERY_FAILED") {
    const now = this.options.clock?.() ?? new Date();
    await this.database.update(notificationOutbox).set({ status: "manual_review", manualReviewAt: now,
      lastErrorCode: errorCode, leaseId: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.leaseId, leaseId),
        eq(notificationOutbox.status, "processing")));
  }
}
