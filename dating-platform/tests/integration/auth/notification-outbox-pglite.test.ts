// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { EncryptionKeyRing, StableHmac } from "@/modules/auth/auth-crypto";
import {
  DurableNotificationDispatcher,
  cleanupNotificationOutbox,
  drainNotificationOutbox,
} from "@/modules/auth/notification-outbox";
import {
  InMemoryMessageSender,
  NotificationDeliveryError,
  type DeliveryContext,
  type SmsOtpMessage,
} from "@/modules/auth/message-sender";

const key = (id: string, byte: number) => ({ id, key: Buffer.alloc(32, byte).toString("base64") });
const deliveryHmac = new StableHmac("stable-delivery-hmac-key-at-least-32-characters");

describe("durable auth notification outbox", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  });

  afterEach(async () => client.close());

  const outbox = (keys = [key("current", 7)]) => new DurableNotificationDispatcher(
    database,
    new EncryptionKeyRing(keys),
    deliveryHmac,
  );

  it("reads old-key work after rotation and writes new work with the active key", async () => {
    const validUntil = new Date(Date.now() + 60_000);
    const old = outbox([key("old", 6)]);
    const message = {
      to: "private@example.test",
      verificationUrl: "https://app.example.test/verify?token=top-secret",
      validUntil,
    };
    await old.enqueueEmailVerification(message);
    await old.enqueueEmailVerification(message);

    const [stored] = await database.select().from(schema.authNotificationDeliveries);
    expect(await database.select().from(schema.authNotificationDeliveries)).toHaveLength(1);
    expect(stored.encryptionKeyId).toBe("old");
    expect(JSON.stringify(stored)).not.toContain(message.to);
    expect(JSON.stringify(stored)).not.toContain("top-secret");

    const rotated = outbox([key("current", 7), key("old", 6)]);
    const sender = new InMemoryMessageSender();
    await drainNotificationOutbox({ outbox: rotated, sender });
    expect(sender.emails).toEqual([{ to: message.to, verificationUrl: message.verificationUrl }]);

    await rotated.enqueuePasswordReset({
      to: "second@example.test",
      resetUrl: "https://app.example.test/reset?token=second",
      validUntil,
    });
    const rows = await database.select().from(schema.authNotificationDeliveries);
    expect(rows.find(({ kind }) => kind === "password_reset")?.encryptionKeyId).toBe("current");
  });

  it("reads null-key-id legacy work only when the legacy key is explicitly configured", async () => {
    const legacy = key("legacy-writer", 12);
    const legacyWriter = new EncryptionKeyRing([legacy]);
    const recipient = legacyWriter.encrypt("legacy@example.test");
    const payload = legacyWriter.encrypt("https://app.example.test/verify?token=legacy");
    await database.insert(schema.authNotificationDeliveries).values({
      kind: "email_verification",
      deliveryKey: "legacy-delivery-key",
      recipientEncrypted: recipient.ciphertext,
      payloadEncrypted: payload.ciphertext,
      encryptionKeyId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const compatible = new DurableNotificationDispatcher(
      database,
      new EncryptionKeyRing([key("current", 13)], { legacyKey: legacy.key }),
      deliveryHmac,
    );
    const sender = new InMemoryMessageSender();
    await drainNotificationOutbox({ outbox: compatible, sender });
    expect(sender.emails).toEqual([{
      to: "legacy@example.test",
      verificationUrl: "https://app.example.test/verify?token=legacy",
    }]);

    await database.insert(schema.authNotificationDeliveries).values({
      kind: "email_verification",
      deliveryKey: "legacy-delivery-key-missing-reader",
      recipientEncrypted: recipient.ciphertext,
      payloadEncrypted: payload.ciphertext,
      encryptionKeyId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await drainNotificationOutbox({ outbox: outbox([key("current", 13)]), sender, maxAttempts: 1 });
    const [failed] = await database.select().from(schema.authNotificationDeliveries)
      .where(eq(schema.authNotificationDeliveries.deliveryKey, "legacy-delivery-key-missing-reader"));
    expect(failed).toMatchObject({
      status: "failed",
      lastError: "AUTH_LEGACY_ENCRYPTION_KEY_UNAVAILABLE",
    });
  });

  it("does not send a credential at or after its exact validity boundary", async () => {
    const now = new Date(Date.now() + 1_000);
    const dispatcher = outbox();
    await dispatcher.enqueueSmsOtp({ to: "+14155550123", code: "123456", validUntil: now });
    const sender = new InMemoryMessageSender();
    await drainNotificationOutbox({ outbox: dispatcher, sender, clock: () => now });
    expect(sender.sms).toHaveLength(0);
    const [row] = await database.select().from(schema.authNotificationDeliveries);
    expect(row).toMatchObject({ status: "expired", recipientEncrypted: null, payloadEncrypted: null });
  });

  it("uses lease CAS so an expired old worker cannot overwrite a newer worker", async () => {
    const start = new Date(Date.now() + 1_000);
    const dispatcher = outbox();
    await dispatcher.enqueueSmsOtp({
      to: "+14155550123",
      code: "123456",
      validUntil: new Date(start.getTime() + 60_000),
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const deliveryKeys: string[] = [];
    const firstSender = new InMemoryMessageSender();
    vi.spyOn(firstSender, "sendSmsOtp").mockImplementation(async (_message, context) => {
      deliveryKeys.push(context.deliveryKey);
      await firstBlocked;
      throw new NotificationDeliveryError();
    });
    const firstDrain = drainNotificationOutbox({
      outbox: dispatcher,
      sender: firstSender,
      leaseMs: 1_000,
      clock: () => start,
    });
    await vi.waitFor(async () => {
      const [row] = await database.select().from(schema.authNotificationDeliveries);
      expect(row.status).toBe("processing");
    });

    const secondSender = new InMemoryMessageSender();
    vi.spyOn(secondSender, "sendSmsOtp").mockImplementation(async (message, context) => {
      deliveryKeys.push(context.deliveryKey);
      secondSender.sms.push(message);
    });
    await drainNotificationOutbox({
      outbox: dispatcher,
      sender: secondSender,
      leaseMs: 1_000,
      clock: () => new Date(start.getTime() + 1_001),
    });
    releaseFirst();
    await firstDrain;

    const [row] = await database.select().from(schema.authNotificationDeliveries);
    expect(row).toMatchObject({ status: "sent", attempts: 1, leaseId: null, leaseExpiresAt: null });
    expect(deliveryKeys).toHaveLength(2);
    expect(new Set(deliveryKeys).size).toBe(1);
  });

  it("retries an ambiguous provider failure with the same delivery idempotency key", async () => {
    const dispatcher = outbox();
    await dispatcher.enqueueSmsOtp({
      to: "+14155550124",
      code: "654321",
      validUntil: new Date(Date.now() + 60_000),
    });
    const keys: string[] = [];
    const sender = new InMemoryMessageSender();
    vi.spyOn(sender, "sendSmsOtp")
      .mockImplementationOnce(async (_message: SmsOtpMessage, context: DeliveryContext) => {
        keys.push(context.deliveryKey);
        throw new NotificationDeliveryError();
      })
      .mockImplementationOnce(async (message: SmsOtpMessage, context: DeliveryContext) => {
        keys.push(context.deliveryKey);
        sender.sms.push(message);
      });

    const firstAt = new Date(Date.now() + 1_000);
    await drainNotificationOutbox({ outbox: dispatcher, sender, clock: () => firstAt });
    await drainNotificationOutbox({
      outbox: dispatcher,
      sender,
      clock: () => new Date(firstAt.getTime() + 3_000),
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("cleans terminal delivery metadata after the retention window", async () => {
    const dispatcher = outbox();
    const now = new Date(Date.now() + 1_000);
    await dispatcher.enqueueSmsOtp({ to: "+14155550125", code: "111111", validUntil: now });
    await drainNotificationOutbox({ outbox: dispatcher, sender: new InMemoryMessageSender(), clock: () => now });
    await database.update(schema.authNotificationDeliveries).set({ updatedAt: new Date(0) });
    await expect(cleanupNotificationOutbox(database, now, 1_000)).resolves.toBe(1);
    expect(await database.select().from(schema.authNotificationDeliveries)
      .where(eq(schema.authNotificationDeliveries.status, "expired"))).toHaveLength(0);
  });
});
