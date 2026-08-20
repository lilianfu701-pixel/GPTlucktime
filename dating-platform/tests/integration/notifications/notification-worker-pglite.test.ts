import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { NotificationDispatcher } from "@/modules/notifications/notification-router";
import { DrizzleInAppNotificationProvider, DrizzleNotificationStore } from "@/modules/notifications/notification-store";

describe("DrizzleNotificationStore", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  const now = new Date("2026-08-05T15:00:00Z");
  const userId = "00000000-0000-4000-8000-000000000101";

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "drizzle" });
    await database.insert(schema.users).values({ id: userId, name: "Owner", email: "owner@example.test",
      phoneNumber: "+15555550101", phoneNumberVerified: true });
    await database.insert(schema.notificationPreferences).values({ userId, locale: "zh-CN", timeZone: "Asia/Shanghai",
      marketingEnabled: false, emailEnabled: true, smsEnabled: false, inAppEnabled: true,
      quietStartHour: 22, quietEndHour: 8 });
  }, 30_000);

  afterEach(async () => client.close());

  it("suppresses opted-out marketing and never leases it", async () => {
    await database.insert(schema.notificationOutbox).values({ userId, dedupeKey: "marketing-1", category: "marketing",
      templateKey: "notifications.marketingNotice", locale: "en", channels: ["email"], availableAt: now });
    const store = new DrizzleNotificationStore(database as never, { hmacKey: "h".repeat(32), clock: () => now });

    await expect(store.claim()).resolves.toBeNull();
    const [row] = await database.select().from(schema.notificationOutbox);
    expect(row).toMatchObject({ status: "suppressed", attempts: 0, leaseId: null });
  });

  it("bounded-scans past suppressed and deferred rows to claim a later deliverable", async () => {
    await database.insert(schema.notificationOutbox).values([
      { userId, dedupeKey: "marketing-head", category: "marketing",
        templateKey: "notifications.marketingNotice", locale: "en", channels: ["email"],
        availableAt: new Date(now.getTime() - 2_000) },
      { userId, dedupeKey: "transactional-quiet-head", category: "transactional",
        templateKey: "notifications.transactionalNotice", locale: "en", channels: ["email"],
        availableAt: new Date(now.getTime() - 1_000) },
      { userId, dedupeKey: "security-after-heads", category: "security",
        templateKey: "notifications.securityNotice", locale: "en", channels: ["email"], availableAt: now },
    ]);
    const store = new DrizzleNotificationStore(database as never, { hmacKey: "h".repeat(32), clock: () => now });

    const claimed = await store.claim();
    expect(claimed).toMatchObject({ templateKey: "notifications.securityNotice", locale: "zh-CN" });
    const rows = await database.select({ dedupeKey: schema.notificationOutbox.dedupeKey,
      status: schema.notificationOutbox.status }).from(schema.notificationOutbox);
    expect(rows).toEqual(expect.arrayContaining([
      { dedupeKey: "marketing-head", status: "suppressed" },
      { dedupeKey: "transactional-quiet-head", status: "pending" },
      { dedupeKey: "security-after-heads", status: "processing" },
    ]));
  });

  it("rechecks consent, locale and security quiet-hour bypass while recovering an expired lease", async () => {
    const [inserted] = await database.insert(schema.notificationOutbox).values({ userId, dedupeKey: "security-1",
      category: "security", templateKey: "notifications.securityNotice", locale: "en",
      channels: ["sms", "email", "inApp"], status: "processing", leaseId: crypto.randomUUID(),
      leaseExpiresAt: new Date("2026-08-05T14:59:00Z"), availableAt: now }).returning();
    const store = new DrizzleNotificationStore(database as never, { hmacKey: "h".repeat(32), clock: () => now });

    const job = await store.claim();
    expect(job).toMatchObject({ id: inserted.id, locale: "zh-CN", channels: ["email", "inApp"], attempts: 1,
      recipient: { email: "owner@example.test", sms: null } });
    expect(job?.providerIdempotencyKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(job?.providerIdempotencyKey).not.toContain("security-1");
  });

  it("moves an exhausted pending delivery to manual review without exceeding its attempt bound", async () => {
    await database.insert(schema.notificationOutbox).values({ userId, dedupeKey: "security-exhausted",
      category: "security", templateKey: "notifications.securityNotice", locale: "en", channels: ["email"],
      attempts: 5, maxAttempts: 5, availableAt: now });
    const store = new DrizzleNotificationStore(database as never, { hmacKey: "h".repeat(32), clock: () => now });

    await expect(store.claim()).resolves.toBeNull();
    const [row] = await database.select().from(schema.notificationOutbox);
    expect(row).toMatchObject({ status: "manual_review", attempts: 5, lastErrorCode: "DELIVERY_FAILED" });
  });

  it("persists redacted retry, terminal review and provider fallback transitions", async () => {
    await database.update(schema.notificationPreferences).set({ inAppEnabled: false })
      .where(eq(schema.notificationPreferences.userId, userId));
    const [first] = await database.insert(schema.notificationOutbox).values({ userId, dedupeKey: "security-retry",
      category: "security", templateKey: "notifications.securityNotice", locale: "en", channels: ["email"],
      availableAt: now }).returning();
    const store = new DrizzleNotificationStore(database as never, { hmacKey: "h".repeat(32), clock: () => now });
    const failing = new NotificationDispatcher({ store,
      providers: [{ channel: "email", deliver: async () => { throw new Error("provider secret detail"); } }],
      clock: () => now });
    await failing.runOne();
    expect((await database.select().from(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.id, first.id)))[0]).toMatchObject({ status: "pending", attempts: 1,
      lastErrorCode: "DELIVERY_FAILED" });
    await database.update(schema.notificationOutbox).set({ attempts: 4, availableAt: now })
      .where(eq(schema.notificationOutbox.id, first.id));
    await failing.runOne();
    const [terminal] = await database.select().from(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.id, first.id));
    expect(terminal).toMatchObject({ status: "manual_review", attempts: 5, lastErrorCode: "DELIVERY_FAILED" });
    expect(JSON.stringify(terminal)).not.toContain("provider secret detail");

    await database.update(schema.notificationPreferences).set({ inAppEnabled: true })
      .where(eq(schema.notificationPreferences.userId, userId));
    const [fallback] = await database.insert(schema.notificationOutbox).values({ userId, dedupeKey: "security-fallback",
      category: "security", templateKey: "notifications.securityNotice", locale: "en", channels: ["email", "inApp"],
      availableAt: now }).returning();
    const dispatcher = new NotificationDispatcher({ store,
      providers: [{ channel: "email", deliver: async () => { throw new Error("provider secret detail"); } },
        { channel: "inApp", deliver: async () => ({ delivered: true }) }], clock: () => now });
    await dispatcher.runOne();
    expect((await database.select().from(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.id, fallback.id)))[0]).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("only reports in-app delivery after a durable idempotent inbox write", async () => {
    const provider = new DrizzleInAppNotificationProvider(database as never);
    const [outbox] = await database.insert(schema.notificationOutbox).values({ userId, dedupeKey: "inbox-write",
      category: "security", templateKey: "privacy.deletionCoolingOff", locale: "zh-CN", channels: ["inApp"],
      availableAt: now }).returning({ id: schema.notificationOutbox.id });
    const job = { id: outbox.id, leaseId: crypto.randomUUID(), userId,
      channels: ["inApp"] as const, attempts: 1, maxAttempts: 5, providerIdempotencyKey: "stable-key",
      templateKey: "privacy.deletionCoolingOff", locale: "zh-CN" as const,
      payload: { executeAt: "2026-09-04T00:00:00.000Z" } };

    await expect(provider.deliver(job, { idempotencyKey: "stable-key:inApp" })).resolves.toEqual({ delivered: true });
    await expect(provider.deliver(job, { idempotencyKey: "stable-key:inApp" })).resolves.toEqual({ delivered: true });
    const rows = await database.select().from(schema.notificationInbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, templateKey: "privacy.deletionCoolingOff", locale: "zh-CN",
      providerIdempotencyKey: "stable-key:inApp" });
  });
});
