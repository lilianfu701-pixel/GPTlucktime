// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { SocialRepository } from "@/modules/social/social-repository";
import { createAuthorizedRealtimePublisher, DrizzleMessageOutboxStore, MessageOutboxConsumer } from "../../../realtime/outbox-consumer";

const NOW = new Date("2026-08-08T12:00:00.000Z");

describe("message outbox PostgreSQL store", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  });
  afterEach(async () => client.close());

  const seed = async () => {
    const users = await database.insert(schema.users).values([
      { name: "outbox-a", email: "outbox-a@test.example" },
      { name: "outbox-b", email: "outbox-b@test.example" },
    ]).returning();
    const [lowUserId, highUserId] = users.map(({ id }) => id).sort();
    await database.insert(schema.profiles).values(users.map((user) => ({
      userId: user.id, displayName: user.name, birthDate: "1990-01-01", genderCode: "person",
      countryCode: "US", city: "Seattle", timeZone: "UTC", status: "active", discoverable: true,
    })));
    const [conversation] = await database.insert(schema.conversations).values({ lowUserId, highUserId }).returning();
    await database.insert(schema.conversationMembers).values([
      { conversationId: conversation.id, userId: lowUserId, lowUserId, highUserId },
      { conversationId: conversation.id, userId: highUserId, lowUserId, highUserId },
    ]);
    const [message] = await database.insert(schema.messages).values({
      conversationId: conversation.id, lowUserId, highUserId, sequence: 1,
      senderUserId: lowUserId, clientId: "00000000-0000-4000-8000-000000000001", body: "private",
    }).returning();
    const [event] = await database.insert(schema.messageOutboxEvents).values({
      messageId: message.id,
      dedupeKey: `message.created:${message.id}`,
      payload: { messageId: message.id, conversationId: conversation.id, senderUserId: lowUserId, sequence: 1 },
      availableAt: NOW,
    }).returning();
    return { event, message, lowUserId, highUserId, conversation };
  };

  it("claims one due event once, then publishes it by matching lease", async () => {
    await seed();
    const store = new DrizzleMessageOutboxStore(database, { clock: () => NOW });
    const [left, right] = await Promise.all([store.claim(1), store.claim(1)]);
    expect([...left, ...right]).toHaveLength(1);
    const claimed = [...left, ...right][0]!;
    expect(await store.markPublished(claimed.id, "00000000-0000-4000-8000-000000000099")).toBe(false);
    expect(await store.markPublished(claimed.id, claimed.leaseId)).toBe(true);
    expect(await store.claim(1)).toEqual([]);
  });

  it("does not publish a claimed pre-block message after the block linearizes", async () => {
    const seeded = await seed();
    await database.insert(schema.userBlocks).values({
      blockerUserId: seeded.lowUserId,
      blockedUserId: seeded.highUserId,
    });
    const social = new SocialRepository(database, {
      cursorSecret: "realtime-test-secret-at-least-32-characters",
      idempotencySecret: "realtime-test-secret-at-least-32-characters",
    });
    let emissions = 0;
    const store = new DrizzleMessageOutboxStore(database, { clock: () => NOW });
    const publish = createAuthorizedRealtimePublisher(database, social, async () => { emissions += 1; });
    await new MessageOutboxConsumer(store, publish).runOnce();
    expect(emissions).toBe(0);
    expect(await database.select().from(schema.messageOutboxEvents)).toMatchObject([{
      id: seeded.event.id,
      status: "suppressed",
      leaseId: null,
      leaseExpiresAt: null,
      suppressionReason: "PAIR_BLOCKED",
      suppressedAt: NOW,
    }]);
    expect(await store.claim(1)).toEqual([]);
  });

  it("publishes once when the dispatcher linearizes before a later block", async () => {
    const seeded = await seed();
    const social = new SocialRepository(database, {
      cursorSecret: "realtime-test-secret-at-least-32-characters",
      idempotencySecret: "realtime-test-secret-at-least-32-characters",
    });
    const store = new DrizzleMessageOutboxStore(database, { clock: () => NOW });
    let emissions = 0;
    const publish = createAuthorizedRealtimePublisher(database, social, async () => { emissions += 1; });
    await new MessageOutboxConsumer(store, publish).runOnce();
    await database.insert(schema.userBlocks).values({
      blockerUserId: seeded.lowUserId,
      blockedUserId: seeded.highUserId,
    });
    expect(emissions).toBe(1);
    expect(await database.select().from(schema.messageOutboxEvents)).toMatchObject([{
      id: seeded.event.id,
      status: "published",
      publishedAt: NOW,
      suppressionReason: null,
      suppressedAt: null,
    }]);
  });

  it("marks an invalid stored payload terminally failed without exposing it to the publisher", async () => {
    const seeded = await seed();
    await database.update(schema.messageOutboxEvents).set({
      payload: { ...seeded.event.payload, sequence: 0 },
    });
    const store = new DrizzleMessageOutboxStore(database, { clock: () => NOW });
    let emissions = 0;
    await new MessageOutboxConsumer(store, async () => { emissions += 1; }).runOnce();
    expect(emissions).toBe(0);
    expect(await database.select().from(schema.messageOutboxEvents)).toMatchObject([{
      status: "failed",
      lastErrorCode: "INVALID_PAYLOAD",
      failedAt: NOW,
      leaseId: null,
      leaseExpiresAt: null,
    }]);
    expect(await store.claim(1)).toEqual([]);
  });
});
