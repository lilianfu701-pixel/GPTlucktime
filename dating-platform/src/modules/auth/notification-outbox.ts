import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, lte, or } from "drizzle-orm";

import { authNotificationDeliveries, users } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import { enqueueProductionNotification } from "@/modules/notifications/notification-producer";

import { EncryptionKeyRing, StableHmac } from "./auth-crypto";
import {
  NOTIFICATION_DELIVERY_FAILED,
  type EmailVerificationMessage,
  type EnqueueEmailVerificationMessage,
  type EnqueuePasswordResetMessage,
  type EnqueueSmsOtpMessage,
  type MessageDispatcher,
  type MessageSender,
  type PasswordResetMessage,
  type SmsOtpMessage,
  type TemplateNotificationMessage,
} from "./message-sender";

type NotificationDatabase = typeof productionDatabase;
type NotificationTransaction = Parameters<Parameters<NotificationDatabase["transaction"]>[0]>[0];
type Delivery = typeof authNotificationDeliveries.$inferSelect;
type DeliveryKind = "email_verification" | "password_reset" | "sms_otp"
  | "deletion_cancellation" | "privacy_export_download";

export class DurableNotificationDispatcher implements MessageDispatcher {
  readonly database: NotificationDatabase;

  constructor(
    database: unknown,
    private readonly encryption: EncryptionKeyRing,
    private readonly deliveryHmac: StableHmac,
  ) {
    this.database = database as NotificationDatabase;
  }

  async assertHealthy(): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const deliveryKey = `health_${randomUUID()}`;
      const [inserted] = await transaction.insert(authNotificationDeliveries).values({
        kind: "email_verification",
        deliveryKey,
        status: "expired",
        expiresAt: new Date(0),
      }).returning({ id: authNotificationDeliveries.id });
      const [readBack] = await transaction.select({ id: authNotificationDeliveries.id })
        .from(authNotificationDeliveries)
        .where(eq(authNotificationDeliveries.id, inserted.id));
      if (!readBack) throw new Error("NOTIFICATION_OUTBOX_UNAVAILABLE");
      await transaction.delete(authNotificationDeliveries)
        .where(eq(authNotificationDeliveries.id, inserted.id));
    });
  }

  async enqueueEmailVerification(message: EnqueueEmailVerificationMessage): Promise<void> {
    await this.enqueue("email_verification", message.to, message.verificationUrl, message.validUntil);
  }

  async enqueuePasswordReset(message: EnqueuePasswordResetMessage): Promise<void> {
    await this.enqueue("password_reset", message.to, message.resetUrl, message.validUntil);
  }

  async enqueueSmsOtp(message: EnqueueSmsOtpMessage): Promise<void> {
    await this.enqueue("sms_otp", message.to, message.code, message.validUntil);
  }

  decrypt(delivery: Delivery): EmailVerificationMessage | PasswordResetMessage | SmsOtpMessage
    | TemplateNotificationMessage {
    if (!delivery.recipientEncrypted || !delivery.payloadEncrypted) {
      throw new Error("AUTH_ENCRYPTED_PAYLOAD_INVALID");
    }
    const to = this.encryption.decrypt({
      keyId: delivery.encryptionKeyId,
      ciphertext: delivery.recipientEncrypted,
      legacyPurpose: delivery.kind === "sms_otp" ? "sms" : "email",
    });
    const payload = this.encryption.decrypt({
      keyId: delivery.encryptionKeyId,
      ciphertext: delivery.payloadEncrypted,
      legacyPurpose: delivery.kind === "sms_otp" ? "sms" : "email",
    });
    if (delivery.kind === "email_verification") return { to, verificationUrl: payload };
    if (delivery.kind === "password_reset") return { to, resetUrl: payload };
    if (delivery.kind === "sms_otp") return { to, code: payload };
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { throw new Error("AUTH_ENCRYPTED_PAYLOAD_INVALID"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("AUTH_ENCRYPTED_PAYLOAD_INVALID");
    }
    const fields = parsed as Record<string, unknown>;
    if ((fields.locale !== "en" && fields.locale !== "zh-CN") || typeof fields.actionUrl !== "string"
      || typeof fields.expiresAt !== "string") throw new Error("AUTH_ENCRYPTED_PAYLOAD_INVALID");
    return { to, locale: fields.locale,
      templateKey: delivery.kind === "deletion_cancellation"
        ? "privacy.deletionCancellationCredential" : "privacy.exportDownloadCredential",
      variables: { actionUrl: fields.actionUrl, expiresAt: fields.expiresAt } };
  }

  async enqueuePrivacyCredential(transaction: NotificationTransaction, input: {
    kind: "deletion_cancellation" | "privacy_export_download";
    recipient: string;
    locale: "en" | "zh-CN";
    actionUrl: string;
    validUntil: Date;
  }): Promise<void> {
    await this.insertEncrypted(transaction, input.kind, input.recipient,
      JSON.stringify({ locale: input.locale, actionUrl: input.actionUrl,
        expiresAt: input.validUntil.toISOString() }), input.validUntil);
  }

  async renewLease(
    id: string,
    leaseId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<boolean> {
    const renewed = await this.database.update(authNotificationDeliveries).set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    }).where(and(
      eq(authNotificationDeliveries.id, id),
      eq(authNotificationDeliveries.leaseId, leaseId),
      eq(authNotificationDeliveries.status, "processing"),
    )).returning({ id: authNotificationDeliveries.id });
    return renewed.length === 1;
  }

  private async enqueue(
    kind: DeliveryKind,
    recipient: string,
    payload: string,
    validUntil: Date,
  ): Promise<void> {
    const recipientEncrypted = this.encryption.encrypt(recipient);
    const payloadEncrypted = this.encryption.encrypt(payload);
    if (recipientEncrypted.keyId !== payloadEncrypted.keyId) {
      throw new Error("AUTH_ENCRYPTION_ACTIVE_KEY_CHANGED");
    }
    const deliveryKey = this.deliveryHmac.digest(kind, recipient, payload);
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction.insert(authNotificationDeliveries).values({ kind, deliveryKey,
        recipientEncrypted: recipientEncrypted.ciphertext, payloadEncrypted: payloadEncrypted.ciphertext,
        encryptionKeyId: recipientEncrypted.keyId, availableAt: now, expiresAt: validUntil,
      }).onConflictDoNothing({ target: authNotificationDeliveries.deliveryKey });
      const [owner] = await transaction.select({ id: users.id }).from(users)
        .where(or(eq(users.email, recipient), eq(users.phoneNumber, recipient))).limit(1);
      if (owner) await enqueueProductionNotification(transaction, { userId: owner.id,
        dedupeKey: `auth-security:${deliveryKey}`, category: "security",
        templateKey: `notifications.${kind === "password_reset" ? "passwordReset"
          : kind === "email_verification" ? "emailVerification" : "smsOtp"}`,
        payload: { expiresAt: validUntil.toISOString() }, preferredChannels: ["inApp"], availableAt: now });
    });
  }

  private async insertEncrypted(transaction: NotificationTransaction, kind: DeliveryKind,
    recipient: string, payload: string, validUntil: Date) {
    const recipientEncrypted = this.encryption.encrypt(recipient);
    const payloadEncrypted = this.encryption.encrypt(payload);
    if (recipientEncrypted.keyId !== payloadEncrypted.keyId) throw new Error("AUTH_ENCRYPTION_ACTIVE_KEY_CHANGED");
    await transaction.insert(authNotificationDeliveries).values({ kind,
      deliveryKey: this.deliveryHmac.digest(kind, recipient, payload),
      recipientEncrypted: recipientEncrypted.ciphertext, payloadEncrypted: payloadEncrypted.ciphertext,
      encryptionKeyId: recipientEncrypted.keyId, availableAt: new Date(), expiresAt: validUntil,
    }).onConflictDoNothing({ target: authNotificationDeliveries.deliveryKey });
  }
}

function redactedDeliveryError(error: unknown): string {
  if (error instanceof Error && [
    "AUTH_ENCRYPTION_KEY_UNAVAILABLE",
    "AUTH_LEGACY_ENCRYPTION_KEY_UNAVAILABLE",
    "AUTH_ENCRYPTED_PAYLOAD_INVALID",
  ].includes(error.message)) return error.message;
  return NOTIFICATION_DELIVERY_FAILED;
}

export async function drainNotificationOutbox(input: {
  outbox: DurableNotificationDispatcher;
  sender: MessageSender;
  clock?: () => Date;
  maxAttempts?: number;
  batchSize?: number;
  leaseMs?: number;
}): Promise<number> {
  const clock = input.clock ?? (() => new Date());
  const maxAttempts = input.maxAttempts ?? 5;
  const batchSize = input.batchSize ?? 50;
  const leaseMs = input.leaseMs ?? 30_000;
  const database = input.outbox.database;
  const queryNow = clock();
  const candidates = await database.select().from(authNotificationDeliveries).where(or(
    and(
      eq(authNotificationDeliveries.status, "pending"),
      lte(authNotificationDeliveries.availableAt, queryNow),
    ),
    and(
      eq(authNotificationDeliveries.status, "processing"),
      lte(authNotificationDeliveries.leaseExpiresAt, queryNow),
    ),
  )).orderBy(asc(authNotificationDeliveries.availableAt)).limit(batchSize);

  let processed = 0;
  for (const candidate of candidates) {
    const claimNow = clock();
    const leaseId = randomUUID();
    const [claimed] = await database.update(authNotificationDeliveries).set({
      status: "processing",
      leaseId,
      leaseExpiresAt: new Date(claimNow.getTime() + leaseMs),
      updatedAt: claimNow,
    }).where(and(
      eq(authNotificationDeliveries.id, candidate.id),
      or(
        and(
          eq(authNotificationDeliveries.status, "pending"),
          lte(authNotificationDeliveries.availableAt, claimNow),
        ),
        and(
          eq(authNotificationDeliveries.status, "processing"),
          lte(authNotificationDeliveries.leaseExpiresAt, claimNow),
        ),
      ),
    )).returning();
    if (!claimed) continue;
    processed += 1;

    const beforeSend = clock();
    if (claimed.expiresAt <= beforeSend) {
      await database.update(authNotificationDeliveries).set({
        status: "expired",
        recipientEncrypted: null,
        payloadEncrypted: null,
        encryptionKeyId: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: "NOTIFICATION_EXPIRED",
        updatedAt: beforeSend,
      }).where(and(
        eq(authNotificationDeliveries.id, claimed.id),
        eq(authNotificationDeliveries.leaseId, leaseId),
        eq(authNotificationDeliveries.status, "processing"),
      ));
      continue;
    }

    try {
      const message = input.outbox.decrypt(claimed);
      const context = { deliveryKey: claimed.deliveryKey };
      if (claimed.kind === "email_verification") {
        await input.sender.sendEmailVerification(message as EmailVerificationMessage, context);
      } else if (claimed.kind === "password_reset") {
        await input.sender.sendPasswordReset(message as PasswordResetMessage, context);
      } else if (claimed.kind === "sms_otp") {
        await input.sender.sendSmsOtp(message as SmsOtpMessage, context);
      } else {
        await input.sender.sendTemplateNotification("email", message as TemplateNotificationMessage, context);
      }
      const completedAt = clock();
      await database.update(authNotificationDeliveries).set({
        status: "sent",
        attempts: claimed.attempts + 1,
        recipientEncrypted: null,
        payloadEncrypted: null,
        encryptionKeyId: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: completedAt,
      }).where(and(
        eq(authNotificationDeliveries.id, claimed.id),
        eq(authNotificationDeliveries.leaseId, leaseId),
        eq(authNotificationDeliveries.status, "processing"),
      ));
    } catch (error) {
      const failedAt = clock();
      const attempts = claimed.attempts + 1;
      const finalFailure = attempts >= maxAttempts;
      await database.update(authNotificationDeliveries).set({
        status: finalFailure ? "failed" : "pending",
        attempts,
        availableAt: new Date(failedAt.getTime() + Math.min(5 * 60_000, 1_000 * (2 ** attempts))),
        recipientEncrypted: finalFailure ? null : claimed.recipientEncrypted,
        payloadEncrypted: finalFailure ? null : claimed.payloadEncrypted,
        encryptionKeyId: finalFailure ? null : claimed.encryptionKeyId,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: redactedDeliveryError(error),
        updatedAt: failedAt,
      }).where(and(
        eq(authNotificationDeliveries.id, claimed.id),
        eq(authNotificationDeliveries.leaseId, leaseId),
        eq(authNotificationDeliveries.status, "processing"),
      ));
    }
  }
  return processed;
}

export async function cleanupNotificationOutbox(
  databaseInput: unknown,
  now = new Date(),
  retentionMs = 30 * 24 * 60 * 60_000,
): Promise<number> {
  const database = databaseInput as NotificationDatabase;
  const deleted = await database.delete(authNotificationDeliveries).where(and(
    inArray(authNotificationDeliveries.status, ["sent", "failed", "expired"]),
    lte(authNotificationDeliveries.updatedAt, new Date(now.getTime() - retentionMs)),
  )).returning({ id: authNotificationDeliveries.id });
  return deleted.length;
}
