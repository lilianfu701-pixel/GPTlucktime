// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import {
  DurableNotificationDispatcher,
  drainNotificationOutbox,
} from "@/modules/auth/notification-outbox";
import { InMemoryMessageSender, NotificationDeliveryError } from "@/modules/auth/message-sender";

const EMAIL_KEY = Buffer.alloc(32, 7).toString("base64");
const SMS_KEY = Buffer.alloc(32, 8).toString("base64");

describe("durable auth notification outbox", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  });

  afterEach(async () => client.close());

  it("persists encrypted, idempotent work and drains it after a dispatcher restart", async () => {
    const first = new DurableNotificationDispatcher(database, {
      emailEncryptionKey: EMAIL_KEY,
      smsEncryptionKey: SMS_KEY,
    });
    const message = {
      to: "private@example.test",
      verificationUrl: "https://app.example.test/verify?token=top-secret",
    };
    await first.enqueueEmailVerification(message);
    await first.enqueueEmailVerification(message);

    const [stored] = await database.select().from(schema.authNotificationDeliveries);
    expect(await database.select().from(schema.authNotificationDeliveries)).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(message.to);
    expect(JSON.stringify(stored)).not.toContain("top-secret");
    await database.update(schema.authNotificationDeliveries).set({
      status: "processing",
      updatedAt: new Date(0),
    });

    const restarted = new DurableNotificationDispatcher(database, {
      emailEncryptionKey: EMAIL_KEY,
      smsEncryptionKey: SMS_KEY,
    });
    const sender = new InMemoryMessageSender();
    await drainNotificationOutbox({ outbox: restarted, sender, processingLeaseMs: 1 });

    expect(sender.emails).toEqual([message]);
    const [sent] = await database.select().from(schema.authNotificationDeliveries);
    expect(sent.status).toBe("sent");
    expect(sent.recipientEncrypted).toBeNull();
    expect(sent.payloadEncrypted).toBeNull();
  });

  it("retries transient failures and clears secrets on final failure", async () => {
    const outbox = new DurableNotificationDispatcher(database, {
      emailEncryptionKey: EMAIL_KEY,
      smsEncryptionKey: SMS_KEY,
    });
    await outbox.enqueueSmsOtp({ to: "+14155550123", code: "123456" });
    const sender = new InMemoryMessageSender();
    vi.spyOn(sender, "sendSmsOtp").mockRejectedValue(new NotificationDeliveryError());

    const firstAttemptAt = new Date(Date.now() + 1_000);
    await drainNotificationOutbox({ outbox, sender, maxAttempts: 2, now: firstAttemptAt });
    let [row] = await database.select().from(schema.authNotificationDeliveries);
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "NOTIFICATION_DELIVERY_FAILED" });
    expect(row.recipientEncrypted).not.toBeNull();

    await drainNotificationOutbox({
      outbox,
      sender,
      maxAttempts: 2,
      now: new Date(firstAttemptAt.getTime() + 3_000),
    });
    [row] = await database.select().from(schema.authNotificationDeliveries);
    expect(row).toMatchObject({ status: "failed", attempts: 2, lastError: "NOTIFICATION_DELIVERY_FAILED" });
    expect(row.recipientEncrypted).toBeNull();
    expect(row.payloadEncrypted).toBeNull();
    expect(JSON.stringify(row)).not.toContain("123456");
  });
});
