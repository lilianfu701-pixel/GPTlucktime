// @vitest-environment node

import { createHmac } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  createIdentityVerificationWebhookHandler,
  cleanupIdentityVerificationWebhookEvents,
  processIdentityVerificationWebhook,
  type VerificationDatabase,
} from "@/modules/auth/identity-verification-webhook";

const provider = "vendor";
const secret = "webhook-integration-secret-at-least-32-chars";

describe("identity verification webhook PostgreSQL integration", () => {
  let client: PGlite;
  let database: PgliteDatabase<typeof schema>;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  const createHandler = () => createIdentityVerificationWebhookHandler({
    provider,
    secret,
    processEvent: (eventProvider, event) => processIdentityVerificationWebhook(
      database as unknown as VerificationDatabase,
      eventProvider,
      event,
    ),
  });

  const send = (event: { eventId: string; providerReference: string; status: "approved" }) => {
    const body = JSON.stringify(event);
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    return createHandler()(new Request("https://app.test/webhook", {
      method: "POST",
      headers: { "x-verification-signature": signature },
      body,
    }), provider);
  };

  async function insertUser(email: string) {
    const [user] = await database.insert(schema.users).values({ email, name: "Webhook User" })
      .returning({ id: schema.users.id });
    return user.id;
  }

  it("stores a duplicate event once and applies its transition once", async () => {
    const userId = await insertUser("duplicate-webhook@example.test");
    await database.insert(schema.verificationAttempts).values({
      userId,
      kind: "identity",
      provider,
      providerReference: "duplicate-reference",
      redirectUrlEncrypted: "encrypted-redirect",
      redirectEncryptionKeyId: "old-key",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const event = {
      eventId: "duplicate-event",
      providerReference: "duplicate-reference",
      status: "approved" as const,
    };

    expect((await send(event)).status).toBe(202);
    expect((await send(event)).status).toBe(202);

    expect(await database.select().from(schema.verificationWebhookEvents)).toHaveLength(1);
    const [attempt] = await database.select().from(schema.verificationAttempts);
    expect(attempt.status).toBe("approved");
    expect(attempt.redirectUrlEncrypted).toBeNull();
    expect(attempt.redirectEncryptionKeyId).toBeNull();
  });

  it("rolls back an event that arrives before its attempt and applies the retry", async () => {
    const event = {
      eventId: "early-event",
      providerReference: "early-reference",
      status: "approved" as const,
    };
    expect((await send(event)).status).toBe(503);
    expect(await database.select().from(schema.verificationWebhookEvents)).toHaveLength(0);

    const userId = await insertUser("early-webhook@example.test");
    const [attempt] = await database.insert(schema.verificationAttempts).values({
      userId,
      kind: "identity",
      provider,
      providerReference: event.providerReference,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();

    expect((await send(event)).status).toBe(202);
    const [applied] = await database.select().from(schema.verificationAttempts);
    const [storedEvent] = await database.select().from(schema.verificationWebhookEvents);
    expect(applied.status).toBe("approved");
    expect(storedEvent.attemptId).toBe(attempt.id);
  });

  it("records but ignores an event for an expired attempt", async () => {
    const userId = await insertUser("expired-webhook@example.test");
    await database.insert(schema.verificationAttempts).values({
      userId,
      kind: "identity",
      provider,
      providerReference: "expired-reference",
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
    });

    expect((await send({
      eventId: "expired-event",
      providerReference: "expired-reference",
      status: "approved",
    })).status).toBe(202);

    const [attempt] = await database.select().from(schema.verificationAttempts);
    expect(attempt.status).toBe("pending");
    expect(await database.select().from(schema.verificationWebhookEvents)).toHaveLength(1);
  });

  it("does not let a superseded attempt overwrite the newer attempt", async () => {
    const userId = await insertUser("superseded-webhook@example.test");
    await database.insert(schema.verificationAttempts).values([
      {
        userId,
        kind: "identity",
        provider,
        providerReference: "older-reference",
        status: "rejected",
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        userId,
        kind: "identity",
        provider,
        providerReference: "newer-reference",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    expect((await send({
      eventId: "superseded-event",
      providerReference: "older-reference",
      status: "approved",
    })).status).toBe(202);

    const attempts = await database.select().from(schema.verificationAttempts)
      .orderBy(asc(schema.verificationAttempts.createdAt));
    expect(attempts.map(({ status }) => status)).toEqual(["rejected", "pending"]);
    expect(await database.select().from(schema.verificationWebhookEvents)
      .where(eq(schema.verificationWebhookEvents.eventId, "superseded-event"))).toHaveLength(1);
  });

  it("removes webhook reservations after the retention window", async () => {
    await database.insert(schema.verificationWebhookEvents).values([
      { provider, eventId: "old-event", providerReference: "old-ref", receivedAt: new Date("2026-01-01") },
      { provider, eventId: "new-event", providerReference: "new-ref", receivedAt: new Date("2026-02-01") },
    ]);
    await expect(cleanupIdentityVerificationWebhookEvents(
      database as unknown as VerificationDatabase,
      new Date("2026-02-15"),
    )).resolves.toBe(1);
    const events = await database.select().from(schema.verificationWebhookEvents);
    expect(events.map(({ eventId }) => eventId)).toEqual(["new-event"]);
  });
});
