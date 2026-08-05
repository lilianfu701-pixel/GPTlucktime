import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { and, asc, eq, lte } from "drizzle-orm";

import { authNotificationDeliveries } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import {
  NOTIFICATION_DELIVERY_FAILED,
  type EmailVerificationMessage,
  type MessageDispatcher,
  type MessageSender,
  type PasswordResetMessage,
  type SmsOtpMessage,
} from "./message-sender";

type NotificationDatabase = Pick<typeof productionDatabase, "insert" | "select" | "update">;
type Delivery = typeof authNotificationDeliveries.$inferSelect;
type DeliveryKind = "email_verification" | "password_reset" | "sms_otp";

export type NotificationEncryptionKeys = {
  emailEncryptionKey?: string;
  smsEncryptionKey?: string;
};

function keyBytes(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("NOTIFICATION_ENCRYPTION_KEY_INVALID");
  }
  return key;
}

function encrypt(key: Buffer, value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(key: Buffer, value: string): string {
  const [version, nonce, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext) throw new Error("NOTIFICATION_PAYLOAD_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function deliveryKey(key: Buffer, kind: DeliveryKind, recipient: string, payload: string): string {
  return createHmac("sha256", key).update(kind).update("\0").update(recipient).update("\0").update(payload).digest("base64url");
}

export class DurableNotificationDispatcher implements MessageDispatcher {
  private readonly emailKey: Buffer | null;
  private readonly smsKey: Buffer | null;
  readonly database: NotificationDatabase;

  constructor(
    database: unknown,
    keys: NotificationEncryptionKeys,
  ) {
    this.database = database as NotificationDatabase;
    this.emailKey = keys.emailEncryptionKey ? keyBytes(keys.emailEncryptionKey) : null;
    this.smsKey = keys.smsEncryptionKey ? keyBytes(keys.smsEncryptionKey) : null;
  }

  async enqueueEmailVerification(message: EmailVerificationMessage): Promise<void> {
    await this.enqueue("email_verification", this.requireKey(this.emailKey), message.to, message.verificationUrl, 24 * 60 * 60_000);
  }

  async enqueueSmsOtp(message: SmsOtpMessage): Promise<void> {
    await this.enqueue("sms_otp", this.requireKey(this.smsKey), message.to, message.code, 10 * 60_000);
  }

  async enqueuePasswordReset(message: PasswordResetMessage): Promise<void> {
    await this.enqueue("password_reset", this.requireKey(this.emailKey), message.to, message.resetUrl, 60 * 60_000);
  }

  keyFor(kind: DeliveryKind): Buffer {
    return this.requireKey(kind === "sms_otp" ? this.smsKey : this.emailKey);
  }

  private requireKey(key: Buffer | null): Buffer {
    if (!key) throw new Error("NOTIFICATION_ENCRYPTION_KEY_UNAVAILABLE");
    return key;
  }

  private async enqueue(kind: DeliveryKind, key: Buffer, recipient: string, payload: string, ttlMs: number): Promise<void> {
    const now = new Date();
    await this.database.insert(authNotificationDeliveries).values({
      kind,
      deliveryKey: deliveryKey(key, kind, recipient, payload),
      recipientEncrypted: encrypt(key, recipient),
      payloadEncrypted: encrypt(key, payload),
      availableAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    }).onConflictDoNothing({ target: authNotificationDeliveries.deliveryKey });
  }
}

function decodeDelivery(outbox: DurableNotificationDispatcher, delivery: Delivery): EmailVerificationMessage | PasswordResetMessage | SmsOtpMessage {
  if (!delivery.recipientEncrypted || !delivery.payloadEncrypted) throw new Error("NOTIFICATION_PAYLOAD_INVALID");
  const key = outbox.keyFor(delivery.kind as DeliveryKind);
  const to = decrypt(key, delivery.recipientEncrypted);
  const payload = decrypt(key, delivery.payloadEncrypted);
  if (delivery.kind === "email_verification") return { to, verificationUrl: payload };
  if (delivery.kind === "password_reset") return { to, resetUrl: payload };
  return { to, code: payload };
}

export async function drainNotificationOutbox(input: {
  outbox: DurableNotificationDispatcher;
  sender: MessageSender;
  now?: Date;
  maxAttempts?: number;
  batchSize?: number;
  processingLeaseMs?: number;
}): Promise<number> {
  const now = input.now ?? new Date();
  const maxAttempts = input.maxAttempts ?? 5;
  const batchSize = input.batchSize ?? 50;
  const database = input.outbox.database;
  await database.update(authNotificationDeliveries).set({
    status: "pending",
    availableAt: now,
    updatedAt: now,
  }).where(and(
    eq(authNotificationDeliveries.status, "processing"),
    lte(
      authNotificationDeliveries.updatedAt,
      new Date(now.getTime() - (input.processingLeaseMs ?? 5 * 60_000)),
    ),
  ));
  const due = await database.select().from(authNotificationDeliveries)
    .where(and(
      eq(authNotificationDeliveries.status, "pending"),
      lte(authNotificationDeliveries.availableAt, now),
    ))
    .orderBy(asc(authNotificationDeliveries.availableAt))
    .limit(batchSize);

  let processed = 0;
  for (const candidate of due) {
    const [claimed] = await database.update(authNotificationDeliveries)
      .set({ status: "processing", updatedAt: now })
      .where(and(
        eq(authNotificationDeliveries.id, candidate.id),
        eq(authNotificationDeliveries.status, "pending"),
      ))
      .returning();
    if (!claimed) continue;
    processed += 1;

    if (claimed.expiresAt <= now) {
      await database.update(authNotificationDeliveries).set({
        status: "expired",
        recipientEncrypted: null,
        payloadEncrypted: null,
        lastError: "NOTIFICATION_EXPIRED",
        updatedAt: now,
      }).where(eq(authNotificationDeliveries.id, claimed.id));
      continue;
    }

    try {
      const message = decodeDelivery(input.outbox, claimed);
      if (claimed.kind === "email_verification") {
        await input.sender.sendEmailVerification(message as EmailVerificationMessage);
      } else if (claimed.kind === "password_reset") {
        await input.sender.sendPasswordReset(message as PasswordResetMessage);
      } else {
        await input.sender.sendSmsOtp(message as SmsOtpMessage);
      }
      await database.update(authNotificationDeliveries).set({
        status: "sent",
        attempts: claimed.attempts + 1,
        recipientEncrypted: null,
        payloadEncrypted: null,
        lastError: null,
        updatedAt: now,
      }).where(eq(authNotificationDeliveries.id, claimed.id));
    } catch (error) {
      const attempts = claimed.attempts + 1;
      const finalFailure = attempts >= maxAttempts || error instanceof SyntaxError;
      await database.update(authNotificationDeliveries).set({
        status: finalFailure ? "failed" : "pending",
        attempts,
        availableAt: new Date(now.getTime() + Math.min(5 * 60_000, 1_000 * (2 ** attempts))),
        recipientEncrypted: finalFailure ? null : claimed.recipientEncrypted,
        payloadEncrypted: finalFailure ? null : claimed.payloadEncrypted,
        lastError: error instanceof Error && error.message === "NOTIFICATION_PAYLOAD_INVALID"
          ? "NOTIFICATION_PAYLOAD_INVALID"
          : NOTIFICATION_DELIVERY_FAILED,
        updatedAt: now,
      }).where(eq(authNotificationDeliveries.id, claimed.id));
    }
  }
  return processed;
}
