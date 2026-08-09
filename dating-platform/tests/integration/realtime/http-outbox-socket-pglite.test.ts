// @vitest-environment node

import { createServer as createHttpServer } from "node:http";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { io as createClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { EntitlementService } from "@/modules/entitlements/entitlement-service";
import { UsageRepository } from "@/modules/entitlements/usage-repository";
import { DrizzleMessageVerificationPolicy, MessageRepository } from "@/modules/messaging/message-repository";
import { createMessagesHandler } from "@/modules/messaging/message-service";
import { SocialRepository } from "@/modules/social/social-repository";
import { createAuthorizedRealtimePublisher, DrizzleMessageOutboxStore, MessageOutboxConsumer } from "../../../realtime/outbox-consumer";
import { createRealtimeServer, type RealtimeMessageEvent } from "../../../realtime/server";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const SECRET = "http-outbox-socket-test-secret-at-least-32";

describe("HTTP to outbox to socket delivery", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  const cleanup: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  });
  afterEach(async () => {
    for (const stop of cleanup.reverse()) await stop();
    cleanup.length = 0;
    await client.close();
  });

  const addPerson = async (name: string) => {
    const [user] = await database.insert(schema.users).values({
      name, email: `${name}@test.example`, emailVerified: true,
      phoneNumber: `+1206555${Math.floor(Math.random() * 8999 + 1000)}`, phoneNumberVerified: true,
    }).returning();
    const [profile] = await database.insert(schema.profiles).values({
      userId: user.id, displayName: name, birthDate: "1990-01-01", genderCode: "person",
      relationshipGoalCode: "long_term", countryCode: "US", city: "Seattle", timeZone: "UTC",
      status: "active", discoverable: true, publishRequested: true,
    }).returning();
    await database.insert(schema.profilePreferences).values({ userId: user.id, languageCodes: ["en"] });
    await database.insert(schema.privacySettings).values({ userId: user.id });
    await database.insert(schema.profilePhotos).values({
      userId: user.id, profileId: profile.id, objectKey: `realtime/${profile.id}.jpg`,
      moderationStatus: "approved", position: 0,
    });
    return { user, profile };
  };

  it("delivers through two authenticated sockets and recovers only the missed durable message", async () => {
    const alice = await addPerson("http-alice");
    const bob = await addPerson("http-bob");
    const social = new SocialRepository(database, {
      clock: () => NOW, cursorSecret: SECRET, idempotencySecret: SECRET,
    });
    const usage = new UsageRepository(database);
    const entitlements = new EntitlementService({
      store: usage,
      timeResolver: async () => NOW,
      policyResolver: (tx, userId, key, now) => usage.resolvePolicyInTransaction(tx, userId, key, now),
      planResolver: async () => null,
    });
    const repository = new MessageRepository(database, {
      interactionPolicy: social,
      entitlementService: entitlements,
      verificationPolicy: new DrizzleMessageVerificationPolicy(),
      cursorSecret: SECRET,
      clock: () => NOW,
    });
    const conversation = await repository.createConversation(alice.user.id, bob.profile.id);
    const senderHandler = createMessagesHandler({
      getSession: async () => ({ user: { id: alice.user.id }, session: { id: "00000000-0000-4000-8000-000000000010" } }),
      repository,
    });
    const recipientHandler = createMessagesHandler({
      getSession: async () => ({ user: { id: bob.user.id }, session: { id: "00000000-0000-4000-8000-000000000011" } }),
      repository,
    });
    const receipts: Array<{ userId: string; messageId: string }> = [];

    const realtime = createRealtimeServer({
      httpServer: createHttpServer(),
      authorization: {
        authenticate: async (ticket) => {
          const userId = ticket === "alice-ticket"
            ? alice.user.id
            : ["bob-ticket", "bob-ticket-2"].includes(ticket) ? bob.user.id : null;
          if (!userId) throw new Error("NOT_AUTHORIZED");
          return {
            userId,
            sessionId: "00000000-0000-4000-8000-000000000011",
            issuedAt: NOW,
            expiresAt: new Date(Date.now() + 60_000),
          };
        },
        authorizeConversation: async (_identity, id) => {
          if (id !== conversation.id) throw new Error("NOT_AUTHORIZED");
          return { conversationId: id, lowUserId: [alice.user.id, bob.user.id].sort()[0]!, highUserId: [alice.user.id, bob.user.id].sort()[1]! };
        },
      },
      receipts: { record: async (userId, input) => {
        receipts.push({ userId, messageId: input.messageId });
        return {};
      } },
    });
    cleanup.push(() => realtime.stop());
    const address = await realtime.start({ host: "127.0.0.1", port: 0 });
    const senderSocket = createClient(address.url, { transports: ["websocket"], reconnection: false, auth: { ticket: "alice-ticket" } });
    const recipientSocket = createClient(address.url, { transports: ["websocket"], reconnection: false, auth: { ticket: "bob-ticket" } });
    cleanup.push(() => { senderSocket.disconnect(); recipientSocket.disconnect(); });
    await Promise.all([
      new Promise<void>((resolve) => senderSocket.once("connect", resolve)),
      new Promise<void>((resolve) => recipientSocket.once("connect", resolve)),
    ]);
    expect(await senderSocket.emitWithAck("conversation.join", { conversationId: conversation.id })).toEqual({ ok: true });
    expect(await recipientSocket.emitWithAck("conversation.join", { conversationId: conversation.id })).toEqual({ ok: true });

    const input = { clientId: "00000000-0000-4000-8000-000000000012", body: "private message" };
    const response = await senderHandler(new Request(`https://app.test/api/v1/conversations/${conversation.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }), { params: Promise.resolve({ conversationId: conversation.id }) });
    expect(response.status).toBe(201);

    const received = new Promise<RealtimeMessageEvent>((resolve) => recipientSocket.once("message.created", resolve));
    const store = new DrizzleMessageOutboxStore(database, { clock: () => NOW });
    const publish = createAuthorizedRealtimePublisher(database, social, realtime.publishMessage);
    const consumer = new MessageOutboxConsumer(store, publish);
    expect(await consumer.runOnce()).toBe(1);
    const event = await received;
    expect(event).toMatchObject({ conversationId: conversation.id, sequence: 1 });
    expect(event).not.toHaveProperty("body");
    expect(await consumer.runOnce()).toBe(0);

    const firstHistory = await recipientHandler(new Request(
      `https://app.test/api/v1/conversations/${conversation.id}/messages?afterSequence=0&pageSize=100`,
    ), { params: Promise.resolve({ conversationId: conversation.id }) });
    const firstRows = await firstHistory.json() as { messages: Array<{ id: string; sequence: number }> };
    expect(firstRows.messages.map(({ sequence }) => sequence)).toEqual([1]);
    recipientSocket.disconnect();

    const secondInput = { clientId: "00000000-0000-4000-8000-000000000013", body: "missed while offline" };
    const secondResponse = await senderHandler(new Request(`https://app.test/api/v1/conversations/${conversation.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(secondInput),
    }), { params: Promise.resolve({ conversationId: conversation.id }) });
    expect(secondResponse.status).toBe(201);
    expect(await consumer.runOnce()).toBe(1);

    const reconnect = createClient(address.url, { transports: ["websocket"], reconnection: false, auth: { ticket: "bob-ticket-2" } });
    cleanup.push(() => { reconnect.disconnect(); });
    await new Promise<void>((resolve) => reconnect.once("connect", resolve));
    expect(await reconnect.emitWithAck("conversation.join", { conversationId: conversation.id })).toEqual({ ok: true });
    const recoveryResponse = await recipientHandler(new Request(
      `https://app.test/api/v1/conversations/${conversation.id}/messages?afterSequence=${event.sequence}&pageSize=100`,
    ), { params: Promise.resolve({ conversationId: conversation.id }) });
    const recovery = await recoveryResponse.json() as { messages: Array<{ id: string; sequence: number }> };
    expect(recovery.messages.map(({ sequence }) => sequence)).toEqual([2]);
    expect([event.sequence, ...recovery.messages.map(({ sequence }) => sequence)]).toEqual([1, 2]);
    expect(await reconnect.emitWithAck("receipt.update", {
      conversationId: conversation.id,
      messageId: recovery.messages[0]!.id,
      kind: "delivered",
      at: NOW.toISOString(),
    })).toMatchObject({ ok: true });
    expect(receipts).toEqual([{ userId: bob.user.id, messageId: recovery.messages[0]!.id }]);

    const replay = await senderHandler(new Request(`https://app.test/api/v1/conversations/${conversation.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }), { params: Promise.resolve({ conversationId: conversation.id }) });
    expect(replay.status).toBe(201);
    expect(await consumer.runOnce()).toBe(0);
  });
});
