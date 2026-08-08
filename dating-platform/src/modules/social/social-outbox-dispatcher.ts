import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import { socialMatches, socialOutboxEvents, userBlocks, users } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type SocialDatabase = typeof productionDatabase;

export type SocialOutboxMessage = {
  eventId: string;
  eventType: "match.created";
  dedupeKey: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
};

export type SocialOutboxSender = (message: SocialOutboxMessage) => Promise<void>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pairFromPayload = (payload: Record<string, unknown>) => {
  const lowUserId = payload.lowUserId;
  const highUserId = payload.highUserId;
  return typeof lowUserId === "string"
    && typeof highUserId === "string"
    && UUID_PATTERN.test(lowUserId)
    && UUID_PATTERN.test(highUserId)
    && lowUserId < highUserId
    ? { lowUserId, highUserId }
    : null;
};

export class SocialOutboxDispatcher {
  private readonly database: SocialDatabase;
  private readonly clock: () => Date;
  private readonly sendTimeoutMs: number;

  constructor(database: unknown, options: { clock?: () => Date; sendTimeoutMs?: number } = {}) {
    this.database = database as SocialDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.sendTimeoutMs = Math.max(1, Math.min(30_000, options.sendTimeoutMs ?? 5_000));
  }

  async dispatch(eventId: string, sender: SocialOutboxSender) {
    const [identity] = await this.database.select({
      eventId: socialOutboxEvents.id,
      aggregateId: socialOutboxEvents.aggregateId,
      aggregateType: socialOutboxEvents.aggregateType,
      eventType: socialOutboxEvents.eventType,
      payload: socialOutboxEvents.payload,
    }).from(socialOutboxEvents).where(eq(socialOutboxEvents.id, eventId)).limit(1);
    if (!identity) return { status: "missing" as const };
    const [storedMatch] = await this.database.select({
      lowUserId: socialMatches.lowUserId,
      highUserId: socialMatches.highUserId,
    }).from(socialMatches).where(eq(socialMatches.id, identity.aggregateId)).limit(1);
    const pair = storedMatch ?? pairFromPayload(identity.payload);

    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as SocialDatabase;
      const lockedUsers = pair
        ? await tx.select({ id: users.id }).from(users)
          .where(inArray(users.id, [pair.lowUserId, pair.highUserId]))
          .orderBy(asc(users.id)).for("update")
        : [];

      const [event] = await tx.select().from(socialOutboxEvents)
        .where(eq(socialOutboxEvents.id, identity.eventId)).for("update").limit(1);
      if (!event) return { status: "missing" as const };
      if (event.status === "published") return { status: "published" as const };
      if (event.status === "suppressed") return { status: "suppressed" as const };
      const now = this.clock();
      if (event.status === "processing") {
        if (!event.leaseId || !event.leaseExpiresAt) return { status: "invalid" as const };
        if (event.leaseExpiresAt > now) return { status: "busy" as const };
      } else if (event.status !== "pending" && event.status !== "failed") {
        return { status: "ignored" as const };
      }

      const [match] = pair && lockedUsers.length === 2
        ? await tx.select({ status: socialMatches.status }).from(socialMatches).where(and(
          eq(socialMatches.id, event.aggregateId),
          eq(socialMatches.lowUserId, pair.lowUserId),
          eq(socialMatches.highUserId, pair.highUserId),
        )).limit(1)
        : [];
      const [block] = pair && lockedUsers.length === 2
        ? await tx.select({ id: userBlocks.id }).from(userBlocks).where(or(
          and(eq(userBlocks.blockerUserId, pair.lowUserId), eq(userBlocks.blockedUserId, pair.highUserId)),
          and(eq(userBlocks.blockerUserId, pair.highUserId), eq(userBlocks.blockedUserId, pair.lowUserId)),
        )).limit(1)
        : [];
      if (identity.eventType !== "match.created"
        || identity.aggregateType !== "match"
        || !pair
        || lockedUsers.length !== 2
        || !match
        || match.status !== "active"
        || block) {
        await tx.update(socialOutboxEvents).set({
          status: "suppressed",
          suppressedAt: now,
          suppressionReason: block ? "pair_blocked" : "match_unavailable",
          publishedAt: null,
          leaseId: null,
          leaseExpiresAt: null,
        }).where(eq(socialOutboxEvents.id, event.id));
        return { status: "suppressed" as const };
      }
      if (event.availableAt > now) return { status: "not_due" as const };

      const leaseId = randomUUID();
      await tx.update(socialOutboxEvents).set({
        status: "processing",
        attempts: sql`${socialOutboxEvents.attempts} + 1`,
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + this.sendTimeoutMs),
        publishedAt: null,
        suppressedAt: null,
        suppressionReason: null,
      }).where(eq(socialOutboxEvents.id, event.id));

      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sender({
            eventId: event.id,
            eventType: "match.created",
            dedupeKey: event.dedupeKey,
            payload: event.payload,
            signal: controller.signal,
          }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("SOCIAL_OUTBOX_SEND_TIMEOUT"));
            }, this.sendTimeoutMs);
          }),
        ]);
      } catch {
        await tx.update(socialOutboxEvents).set({
          status: "failed",
          leaseId: null,
          leaseExpiresAt: null,
        }).where(and(
          eq(socialOutboxEvents.id, event.id),
          eq(socialOutboxEvents.leaseId, leaseId),
        ));
        return { status: "failed" as const };
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      await tx.update(socialOutboxEvents).set({
        status: "published",
        publishedAt: this.clock(),
        leaseId: null,
        leaseExpiresAt: null,
      }).where(and(
        eq(socialOutboxEvents.id, event.id),
        eq(socialOutboxEvents.leaseId, leaseId),
      ));
      return { status: "published" as const };
    });
  }
}
