import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createFreeTestRedisClient,
  FreeTestNotificationAdapter,
  FREE_TEST_MAILBOX_TTL_SECONDS,
  FREE_TEST_REDIS_CONNECT_TIMEOUT_MS,
  FREE_TEST_REDIS_SOCKET_TIMEOUT_MS,
} from "@/modules/auth/free-test-notification-adapter";
import { NotificationNotConfiguredError } from "@/modules/auth/message-sender";

type Entry = { value: string; expiresAt: number };

class RedisMailboxDouble {
  isOpen = false;
  readonly entries = new Map<string, Entry>();
  lastSet: { key: string; ttl: number } | null = null;
  pingResult = "PONG";
  setCalls = 0;

  constructor(private readonly now: () => number) {}

  async connect() { this.isOpen = true; }
  async ping() { return this.pingResult; }
  async set(key: string, value: string, options: { EX: number }) {
    this.setCalls += 1;
    this.lastSet = { key, ttl: options.EX };
    this.entries.set(key, { value, expiresAt: this.now() + options.EX * 1_000 });
    return "OK";
  }
  async getDel(key: string) {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry && entry.expiresAt > this.now() ? entry.value : null;
  }
}

const secret = "free-test-access-secret-at-least-32-characters";
const appUrl = "https://dating.example.test";

describe("free-test notification adapter", () => {
  it("creates a bounded node-redis client with a silent error listener and finite reconnects", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = createFreeTestRedisClient("redis://localhost:6379");
    const inspected = client as unknown as { options: { socket: { connectTimeout: number; socketTimeout: number;
      reconnectStrategy: (retries: number, cause: Error) => false | number } };
      listenerCount(event: string): number; emit(event: string, error: Error): boolean };
    expect(inspected.options.socket.connectTimeout).toBe(FREE_TEST_REDIS_CONNECT_TIMEOUT_MS);
    expect(inspected.options.socket.socketTimeout).toBe(FREE_TEST_REDIS_SOCKET_TIMEOUT_MS);
    expect(inspected.options.socket.reconnectStrategy(0, new Error("connection failed"))).toBeTypeOf("number");
    expect(inspected.options.socket.reconnectStrategy(2, new Error("connection failed"))).toBe(false);
    expect(inspected.listenerCount("error")).toBeGreaterThan(0);
    expect(() => inspected.emit("error", new Error("redis-url-with-secret"))).not.toThrow();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it.each(["person@example.test", "person@sub.datecn.test", "bad@@datecn.test", ".bad@datecn.test"])(
    "rejects non-test or malformed recipient %s",
    async (to) => {
      const redis = new RedisMailboxDouble(Date.now);
      const adapter = new FreeTestNotificationAdapter({ redis, accessSecret: secret, appUrl });
      await expect(adapter.enqueueEmailVerification({ to, verificationUrl: `${appUrl}/verify`,
        validUntil: new Date(Date.now() + 60_000) })).rejects.toThrow("FREE_TEST_RECIPIENT_REQUIRED");
      expect(redis.entries.size).toBe(0);
    },
  );

  it("canonicalizes recipients, keeps only the newest item, and uses an opaque 900-second Redis key", async () => {
    let now = Date.parse("2026-08-25T00:00:00.000Z");
    const redis = new RedisMailboxDouble(() => now);
    const adapter = new FreeTestNotificationAdapter({ redis, accessSecret: secret, appUrl, now: () => new Date(now) });

    await adapter.enqueueEmailVerification({ to: "Alice@DATECN.TEST", verificationUrl: `${appUrl}/verify/first`,
      validUntil: new Date(now + 30 * 60_000) });
    now += 1_000;
    await adapter.enqueuePasswordReset({ to: "alice@datecn.test", resetUrl: `${appUrl}/reset/newest`,
      validUntil: new Date(now + 30 * 60_000) });

    expect(redis.entries.size).toBe(1);
    expect(redis.lastSet?.ttl).toBe(FREE_TEST_MAILBOX_TTL_SECONDS);
    expect(redis.lastSet?.key).not.toContain("alice");
    expect(redis.lastSet?.key).not.toContain("datecn.test");
    await expect(adapter.consumeLatest("ALICE@DATECN.TEST")).resolves.toEqual({
      kind: "password_reset",
      actionUrl: `${appUrl}/reset/newest`,
      expiresAt: new Date(now + FREE_TEST_MAILBOX_TTL_SECONDS * 1_000).toISOString(),
    });
    await expect(adapter.consumeLatest("alice@datecn.test")).resolves.toBeNull();
  });

  it("fails closed for expired, tampered, or recipient-mismatched ciphertext", async () => {
    let now = Date.parse("2026-08-25T00:00:00.000Z");
    const redis = new RedisMailboxDouble(() => now);
    const adapter = new FreeTestNotificationAdapter({ redis, accessSecret: secret, appUrl, now: () => new Date(now) });
    await adapter.enqueueEmailVerification({ to: "expired@datecn.test", verificationUrl: `${appUrl}/verify/expired`,
      validUntil: new Date(now + 1_000) });
    now += 1_001;
    await expect(adapter.consumeLatest("expired@datecn.test")).resolves.toBeNull();

    now -= 1_001;
    await adapter.enqueueEmailVerification({ to: "tamper@datecn.test", verificationUrl: `${appUrl}/verify/tamper`,
      validUntil: new Date(now + 60_000) });
    const [tamperKey, tamperEntry] = [...redis.entries.entries()][0]!;
    const [iv, tag, encrypted] = tamperEntry.value.split(".");
    const encryptedBytes = Buffer.from(encrypted!, "base64url");
    encryptedBytes[0] = encryptedBytes[0]! ^ 1;
    redis.entries.set(tamperKey, { ...tamperEntry,
      value: `${iv}.${tag}.${encryptedBytes.toString("base64url")}` });
    await expect(adapter.consumeLatest("tamper@datecn.test")).resolves.toBeNull();
    await expect(adapter.consumeLatest("tamper@datecn.test")).resolves.toBeNull();

    await adapter.enqueueEmailVerification({ to: "first@datecn.test", verificationUrl: `${appUrl}/verify/first`,
      validUntil: new Date(now + 60_000) });
    const firstEntry = [...redis.entries.values()][0]!;
    await adapter.enqueueEmailVerification({ to: "second@datecn.test", verificationUrl: `${appUrl}/verify/second`,
      validUntil: new Date(now + 60_000) });
    const secondKey = [...redis.entries.keys()].find((key) => redis.entries.get(key)?.value !== firstEntry.value)!;
    redis.entries.set(secondKey, firstEntry);
    await expect(adapter.consumeLatest("second@datecn.test")).resolves.toBeNull();
  });

  it.each(["http://dating.example.test/verify", "https://evil.example.test/verify", "not-a-url"])(
    "rejects unsafe action URL %s",
    async (verificationUrl) => {
      const adapter = new FreeTestNotificationAdapter({ redis: new RedisMailboxDouble(Date.now),
        accessSecret: secret, appUrl });
      await expect(adapter.enqueueEmailVerification({ to: "safe@datecn.test", verificationUrl,
        validUntil: new Date(Date.now() + 60_000) })).rejects.toThrow("FREE_TEST_NOTIFICATION_INVALID");
    },
  );

  it("rejects a multi-megabyte same-origin URL before Redis storage", async () => {
    const redis = new RedisMailboxDouble(Date.now);
    const adapter = new FreeTestNotificationAdapter({ redis, accessSecret: secret, appUrl });
    const oversized = `${appUrl}/${"a".repeat(2 * 1024 * 1024)}`;
    await expect(adapter.enqueueEmailVerification({ to: "safe@datecn.test", verificationUrl: oversized,
      validUntil: new Date(Date.now() + 60_000) })).rejects.toThrow("FREE_TEST_NOTIFICATION_INVALID");
    expect(redis.setCalls).toBe(0);
  });

  it("rejects oversized encoded ciphertext before decryption", async () => {
    const redis = new RedisMailboxDouble(Date.now);
    const adapter = new FreeTestNotificationAdapter({ redis, accessSecret: secret, appUrl });
    await adapter.enqueueEmailVerification({ to: "large@datecn.test", verificationUrl: `${appUrl}/verify`,
      validUntil: new Date(Date.now() + 60_000) });
    const [key, entry] = [...redis.entries.entries()][0]!;
    redis.entries.set(key, { ...entry, value: "a".repeat(2 * 1024 * 1024) });
    await expect(adapter.consumeLatest("large@datecn.test")).resolves.toBeNull();
  });

  it("never calls fetch and refuses SMS and template delivery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new FreeTestNotificationAdapter({ redis: new RedisMailboxDouble(Date.now),
      accessSecret: secret, appUrl });
    await adapter.sendEmailVerification({ to: "safe@datecn.test", verificationUrl: `${appUrl}/verify` },
      { deliveryKey: "ignored" });
    await expect(adapter.sendSmsOtp({ to: "+12065550100", code: "123456" },
      { deliveryKey: "ignored" })).rejects.toEqual(new NotificationNotConfiguredError("sms"));
    await expect(adapter.sendTemplateNotification("email", { to: "safe@datecn.test", templateKey: "x", locale: "en" },
      { deliveryKey: "ignored" })).rejects.toThrow("FREE_TEST_NOTIFICATION_UNAVAILABLE");
    expect(() => adapter.assertAvailable("sms")).toThrow(NotificationNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("checks Redis health and fails closed", async () => {
    const redis = new RedisMailboxDouble(Date.now);
    const adapter = new FreeTestNotificationAdapter({ redis, accessSecret: secret, appUrl });
    await expect(adapter.assertHealthy()).resolves.toBeUndefined();
    expect(redis.isOpen).toBe(true);
    redis.pingResult = "unexpected";
    await expect(adapter.assertHealthy()).rejects.toThrow("NOTIFICATION_OUTBOX_UNAVAILABLE");
  });
});
