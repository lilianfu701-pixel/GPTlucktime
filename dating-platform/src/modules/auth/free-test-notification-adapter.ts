import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createClient } from "redis";

import {
  NOTIFICATION_OUTBOX_UNAVAILABLE,
  NotificationNotConfiguredError,
  type DeliveryContext,
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
import { canonicalizeFreeTestEmail } from "./free-test-recipient";

export const FREE_TEST_MAILBOX_TTL_SECONDS = 900;
export const FREE_TEST_ACTION_URL_MAX_BYTES = 4_096;
export const FREE_TEST_REDIS_CONNECT_TIMEOUT_MS = 3_000;
export const FREE_TEST_REDIS_SOCKET_TIMEOUT_MS = 5_000;
const FREE_TEST_PLAINTEXT_MAX_BYTES = FREE_TEST_ACTION_URL_MAX_BYTES * 2 + 1_024;
const base64UrlMaxLength = (bytes: number) => Math.ceil(bytes * 4 / 3);
const FREE_TEST_ENCODED_MAX_LENGTH = base64UrlMaxLength(12) + base64UrlMaxLength(16)
  + base64UrlMaxLength(FREE_TEST_PLAINTEXT_MAX_BYTES) + 2;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const INVALID = "FREE_TEST_NOTIFICATION_INVALID";
const UNAVAILABLE = "FREE_TEST_NOTIFICATION_UNAVAILABLE";
const RECIPIENT_REQUIRED = "FREE_TEST_RECIPIENT_REQUIRED";
const AAD = Buffer.from("datecn/free-test-mailbox/v1", "utf8");
type RedisMailbox = {
  isOpen?: boolean;
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  set(key: string, value: string, options: { EX: number }): Promise<string | null>;
  getDel(key: string): Promise<string | null>;
};

export type FreeTestMailboxItem = {
  kind: "email_verification" | "password_reset";
  actionUrl: string;
  expiresAt: string;
};

type StoredItem = FreeTestMailboxItem & { version: 1; recipient: string };

export function createFreeTestRedisClient(redisUrl: string) {
  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: FREE_TEST_REDIS_CONNECT_TIMEOUT_MS,
      socketTimeout: FREE_TEST_REDIS_SOCKET_TIMEOUT_MS,
      reconnectStrategy: (retries) => retries >= 2 ? false : Math.min(500, 100 * (2 ** retries)),
    },
  });
  client.on("error", () => undefined);
  return client;
}

function deriveKey(secret: string, purpose: "encryption" | "mailbox"): Buffer {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`datecn/free-test/${purpose}/v1`, "utf8")
    .digest();
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export class FreeTestNotificationAdapter implements MessageSender, MessageDispatcher {
  private readonly redis: RedisMailbox;
  private readonly encryptionKey: Buffer;
  private readonly mailboxKey: Buffer;
  private readonly appOrigin: string;
  private readonly now: () => Date;

  constructor(options: { redis: unknown; accessSecret: string; appUrl: string; now?: () => Date }) {
    const secret = options.accessSecret.trim();
    if (secret.length < 32 || secret.length > 256) throw new Error(INVALID);
    const app = new URL(options.appUrl);
    if (app.protocol !== "https:" || app.username || app.password) throw new Error(INVALID);
    this.redis = options.redis as RedisMailbox;
    this.encryptionKey = deriveKey(secret, "encryption");
    this.mailboxKey = deriveKey(secret, "mailbox");
    this.appOrigin = app.origin;
    this.now = options.now ?? (() => new Date());
  }

  assertAvailable(channel: "email" | "sms"): void {
    if (channel !== "email") throw new NotificationNotConfiguredError(channel);
  }

  async assertHealthy(): Promise<void> {
    try {
      await this.connect();
      if (await this.redis.ping() !== "PONG") throw new Error(UNAVAILABLE);
    } catch {
      throw new Error(NOTIFICATION_OUTBOX_UNAVAILABLE);
    }
  }

  sendEmailVerification(message: EmailVerificationMessage, context: DeliveryContext): Promise<void> {
    void context;
    return this.store("email_verification", message.to, message.verificationUrl);
  }

  sendPasswordReset(message: PasswordResetMessage, context: DeliveryContext): Promise<void> {
    void context;
    return this.store("password_reset", message.to, message.resetUrl);
  }

  async sendSmsOtp(message: SmsOtpMessage, context: DeliveryContext): Promise<void> {
    void message; void context;
    throw new NotificationNotConfiguredError("sms");
  }

  async sendTemplateNotification(channel: "email" | "sms", message: TemplateNotificationMessage,
    context: DeliveryContext): Promise<void> {
    void channel; void message; void context;
    throw new Error(UNAVAILABLE);
  }

  enqueueEmailVerification(message: EnqueueEmailVerificationMessage): Promise<void> {
    return this.store("email_verification", message.to, message.verificationUrl, message.validUntil);
  }

  enqueuePasswordReset(message: EnqueuePasswordResetMessage): Promise<void> {
    return this.store("password_reset", message.to, message.resetUrl, message.validUntil);
  }

  async enqueueSmsOtp(message: EnqueueSmsOtpMessage): Promise<void> {
    void message;
    throw new NotificationNotConfiguredError("sms");
  }

  async consumeLatest(recipient: string): Promise<FreeTestMailboxItem | null> {
    const canonical = canonicalizeFreeTestEmail(recipient);
    if (!canonical) return null;
    let ciphertext: string | null;
    try {
      await this.connect();
      ciphertext = await this.redis.getDel(this.keyFor(canonical));
    } catch {
      throw new Error(UNAVAILABLE);
    }
    if (!ciphertext) return null;
    try {
      const item = this.decrypt(ciphertext);
      const expiresAt = Date.parse(item.expiresAt);
      const now = this.now().getTime();
      if (!constantTimeEqual(item.recipient, canonical) || expiresAt <= now
        || expiresAt > now + FREE_TEST_MAILBOX_TTL_SECONDS * 1_000
        || !this.safeActionUrl(item.actionUrl)) return null;
      return { kind: item.kind, actionUrl: item.actionUrl, expiresAt: item.expiresAt };
    } catch {
      return null;
    }
  }

  private async connect(): Promise<void> {
    if (!this.redis.isOpen) await this.redis.connect();
  }

  private keyFor(recipient: string): string {
    return `free-test:mailbox:${createHmac("sha256", this.mailboxKey).update(recipient).digest("base64url")}`;
  }

  private safeActionUrl(value: string): boolean {
    if (Buffer.byteLength(value, "utf8") > FREE_TEST_ACTION_URL_MAX_BYTES) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === this.appOrigin && !url.username && !url.password;
    } catch { return false; }
  }

  private async store(kind: FreeTestMailboxItem["kind"], recipient: string, actionUrl: string,
    validUntil?: Date): Promise<void> {
    const canonical = canonicalizeFreeTestEmail(recipient);
    if (!canonical) throw new Error(RECIPIENT_REQUIRED);
    if (!this.safeActionUrl(actionUrl)) throw new Error(INVALID);
    const now = this.now().getTime();
    const expiresAt = new Date(Math.min(validUntil?.getTime() ?? Number.POSITIVE_INFINITY,
      now + FREE_TEST_MAILBOX_TTL_SECONDS * 1_000));
    if (!Number.isFinite(expiresAt.getTime())) throw new Error(INVALID);
    const plaintext = JSON.stringify({ version: 1, recipient: canonical, kind, actionUrl,
      expiresAt: expiresAt.toISOString() } satisfies StoredItem);
    if (Buffer.byteLength(plaintext, "utf8") > FREE_TEST_PLAINTEXT_MAX_BYTES) throw new Error(INVALID);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const encoded = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
    try {
      await this.connect();
      if (await this.redis.set(this.keyFor(canonical), encoded, { EX: FREE_TEST_MAILBOX_TTL_SECONDS }) !== "OK") {
        throw new Error(UNAVAILABLE);
      }
    } catch { throw new Error(UNAVAILABLE); }
  }

  private decrypt(encoded: string): StoredItem {
    if (encoded.length > FREE_TEST_ENCODED_MAX_LENGTH) throw new Error(INVALID);
    const parts = encoded.split(".");
    if (parts.length !== 3) throw new Error(INVALID);
    if (parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) throw new Error(INVALID);
    const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part!, "base64url"));
    if (iv!.length !== 12 || tag!.length !== 16 || encrypted!.length > FREE_TEST_PLAINTEXT_MAX_BYTES) {
      throw new Error(INVALID);
    }
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv!);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag!);
    const plaintext = Buffer.concat([decipher.update(encrypted!), decipher.final()]);
    if (plaintext.byteLength > FREE_TEST_PLAINTEXT_MAX_BYTES) throw new Error(INVALID);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(INVALID);
    const item = parsed as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "actionUrl,expiresAt,kind,recipient,version"
      || item.version !== 1 || typeof item.recipient !== "string" || typeof item.actionUrl !== "string"
      || typeof item.expiresAt !== "string"
      || (item.kind !== "email_verification" && item.kind !== "password_reset")) throw new Error(INVALID);
    if (!canonicalizeFreeTestEmail(item.recipient) || !this.safeActionUrl(item.actionUrl)
      || !ISO_TIMESTAMP.test(item.expiresAt) || item.expiresAt.length !== 24
      || new Date(item.expiresAt).toISOString() !== item.expiresAt) throw new Error(INVALID);
    return item as StoredItem;
  }
}
