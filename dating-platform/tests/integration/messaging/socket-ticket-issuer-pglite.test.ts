// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  DrizzleSocketTicketIssuer,
  parseSocketTicketKeyRing,
  verifySocketTicket,
} from "@/modules/messaging/socket-ticket";
import { allowAllRestrictionPolicy } from "@/modules/moderation/restriction-policy";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const keys = parseSocketTicketKeyRing(`active:${Buffer.alloc(32, 4).toString("base64url")}`);

describe("socket ticket issuer", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  });
  afterEach(async () => client.close());

  it("issues only for a current database session and active account", async () => {
    const [{ id: userId }] = await database.insert(schema.users).values({
      name: "Ticket User", email: "ticket-user@example.test",
    }).returning({ id: schema.users.id });
    await database.insert(schema.profiles).values({ userId, status: "active", discoverable: false });
    const [{ id: sessionId }] = await database.insert(schema.sessions).values({
      userId,
      token: "opaque-session-token",
      expiresAt: new Date(NOW.getTime() + 60_000),
    }).returning({ id: schema.sessions.id });
    const issuer = new DrizzleSocketTicketIssuer(database, keys, {
      clock: () => NOW, restrictionPolicy: allowAllRestrictionPolicy,
    });
    const signed = await issuer.issue(userId, sessionId);
    expect(verifySocketTicket(signed.ticket, keys, NOW)).toMatchObject({ sub: userId, sessionId });

    await database.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    await expect(issuer.issue(userId, sessionId)).rejects.toThrow("REALTIME_SESSION_NOT_AVAILABLE");
  });

  it("rejects expired, cross-user, and restricted sessions without exposing which condition failed", async () => {
    const [{ id: userId }] = await database.insert(schema.users).values({
      name: "Ticket Restricted", email: "ticket-restricted@example.test",
    }).returning({ id: schema.users.id });
    const [{ id: otherUserId }] = await database.insert(schema.users).values({
      name: "Ticket Other", email: "ticket-other@example.test",
    }).returning({ id: schema.users.id });
    await database.insert(schema.profiles).values({ userId, status: "restricted" });
    const [{ id: sessionId }] = await database.insert(schema.sessions).values({
      userId,
      token: "expired-session-token",
      expiresAt: NOW,
    }).returning({ id: schema.sessions.id });
    const issuer = new DrizzleSocketTicketIssuer(database, keys, {
      clock: () => NOW, restrictionPolicy: allowAllRestrictionPolicy,
    });
    for (const ownerId of [userId, otherUserId]) {
      await expect(issuer.issue(ownerId, sessionId)).rejects.toThrow("REALTIME_SESSION_NOT_AVAILABLE");
    }
  });
});
