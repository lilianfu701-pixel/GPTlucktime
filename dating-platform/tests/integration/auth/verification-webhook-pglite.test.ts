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
  });

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
        status: "pending",
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
    expect(attempts.map(({ status }) => status)).toEqual(["pending", "pending"]);
    expect(await database.select().from(schema.verificationWebhookEvents)
      .where(eq(schema.verificationWebhookEvents.eventId, "superseded-event"))).toHaveLength(1);
  });
});
