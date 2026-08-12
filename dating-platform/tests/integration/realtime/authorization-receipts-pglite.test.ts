// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { MessageReceiptRepository } from "@/modules/messaging/message-receipt-repository";
import { MessageReceiptService } from "@/modules/messaging/message-receipt-service";
import { parseSocketTicketKeyRing, signSocketTicket } from "@/modules/messaging/socket-ticket";
import { allowAllRestrictionPolicy, DrizzleModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";
import { DrizzleRealtimeAuthorization } from "../../../realtime/authenticate-socket";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const keyRing = parseSocketTicketKeyRing(`current:${Buffer.alloc(32, 7).toString("base64url")}`);

describe("real-time authorization and receipts", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  }, 30_000);

  afterEach(async () => client.close());

  const addUser = async (name: string) => {
    const [user] = await database.insert(schema.users).values({
      name, email: `${name}@test.example`, emailVerified: true,
    }).returning();
    const [profile] = await database.insert(schema.profiles).values({
      userId: user.id, displayName: name, birthDate: "1990-01-01", genderCode: "person",
      relationshipGoalCode: "long_term", countryCode: "US", city: "Seattle", timeZone: "UTC",
      status: "active", discoverable: true,
    }).returning();
    const [session] = await database.insert(schema.sessions).values({
      userId: user.id, token: `${name}-session`, expiresAt: new Date("2026-08-08T13:00:00Z"),
    }).returning();
    return { user, profile, session };
  };

  const addConversation = async (left: string, right: string) => {
    const [lowUserId, highUserId] = [left, right].sort();
    const [conversation] = await database.insert(schema.conversations).values({ lowUserId, highUserId }).returning();
    await database.insert(schema.conversationMembers).values([
      { conversationId: conversation.id, userId: lowUserId, lowUserId, highUserId },
      { conversationId: conversation.id, userId: highUserId, lowUserId, highUserId },
    ]);
    return conversation;
  };

  it("verifies JWT then rechecks session ownership, expiry, active profile, membership, block and revocation", async () => {
    const alice = await addUser("auth-alice");
    const bob = await addUser("auth-bob");
    const conversation = await addConversation(alice.user.id, bob.user.id);
    const authorization = new DrizzleRealtimeAuthorization(database, keyRing, {
      clock: () => NOW,
      restrictionPolicy: allowAllRestrictionPolicy,
    });
    const signed = signSocketTicket({ sub: alice.user.id, sessionId: alice.session.id }, keyRing, NOW).ticket;
    const identity = await authorization.authenticate(signed);
    expect(identity).toMatchObject({ userId: alice.user.id, sessionId: alice.session.id, issuedAt: NOW });
    await expect(authorization.authorizeConversation(identity, conversation.id)).resolves.toMatchObject({
      conversationId: conversation.id,
    });

    await database.update(schema.sessions)
      .set({ expiresAt: new Date("2026-08-08T12:02:00.000Z") })
      .where(eq(schema.sessions.id, alice.session.id));
    const sessionBoundIdentity = await authorization.authenticate(signed);
    expect(sessionBoundIdentity.expiresAt).toEqual(new Date("2026-08-08T12:02:00.000Z"));

    await database.insert(schema.realtimePairRevocations).values({
      lowUserId: [alice.user.id, bob.user.id].sort()[0]!,
      highUserId: [alice.user.id, bob.user.id].sort()[1]!,
      revokedBefore: NOW,
    });
    await expect(authorization.authorizeConversation(identity, conversation.id)).rejects.toThrow("NOT_AUTHORIZED");
    await database.delete(schema.realtimePairRevocations);
    await database.update(schema.sessions).set({ expiresAt: NOW }).where(eq(schema.sessions.id, alice.session.id));
    await expect(authorization.authenticate(signed)).rejects.toThrow("NOT_AUTHORIZED");
  });

  it("rejects socket authentication immediately for an all-interactions restricted subject", async () => {
    const alice = await addUser("restricted-socket-auth");
    const reporter = await addUser("restricted-socket-reporter");
    const authorization = new DrizzleRealtimeAuthorization(database, keyRing, {
      clock: () => NOW,
      restrictionPolicy: new DrizzleModerationRestrictionPolicy(),
    });
    const signed = signSocketTicket({ sub: alice.user.id, sessionId: alice.session.id }, keyRing, NOW).ticket;
    const [report] = await database.insert(schema.reports).values({
      reporterUserId: reporter.user.id,
      targetUserId: alice.user.id,
      targetProfileId: alice.profile.id,
      targetType: "profile",
      reasonCode: "HARASSMENT",
      locale: "en-US",
      explanation: "socket restriction fixture",
      clientId: crypto.randomUUID(),
      requestHash: "a".repeat(64),
      dedupeKey: "b".repeat(64),
      targetSnapshot: {
        schemaVersion: 1,
        targetType: "profile",
        targetUserId: alice.user.id,
        targetProfileId: alice.profile.id,
        capturedAt: NOW.toISOString(),
        displayName: alice.user.name,
        messageId: null,
        conversationId: null,
      },
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
    const [moderationCase] = await database.insert(schema.moderationCases).values({
      reportId: report.id, createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.insert(schema.userRestrictions).values({
      subjectUserId: alice.user.id,
      sourceCaseId: moderationCase.id,
      scope: "all_interactions",
      reasonCode: "TEST_RESTRICTION",
      startsAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await expect(authorization.authenticate(signed)).rejects.toThrow("NOT_AUTHORIZED");
  });

  it("upserts recipient receipts monotonically and read implies delivered", async () => {
    const alice = await addUser("receipt-alice");
    const bob = await addUser("receipt-bob");
    const conversation = await addConversation(alice.user.id, bob.user.id);
    const [message] = await database.insert(schema.messages).values({
      conversationId: conversation.id,
      lowUserId: conversation.lowUserId,
      highUserId: conversation.highUserId,
      sequence: 1,
      senderUserId: alice.user.id,
      clientId: "00000000-0000-4000-8000-000000000999",
      body: "private",
    }).returning();
    const repository = new MessageReceiptRepository(database, {
      interactionPolicy: {
        withAllowedInteraction: async (_actor, _target, write) => database.transaction((tx) => write(tx as never)),
      },
      restrictionPolicy: allowAllRestrictionPolicy,
      clock: () => NOW,
    });
    await expect(repository.record(alice.user.id, { messageId: message.id, conversationId: conversation.id, kind: "read", at: NOW.toISOString() }))
      .rejects.toThrow("RECEIPT_NOT_AVAILABLE");
    const read = await repository.record(bob.user.id, {
      messageId: message.id, conversationId: conversation.id, kind: "read", at: NOW.toISOString(),
    });
    expect(read).toMatchObject({ deliveredAt: NOW.toISOString(), readAt: NOW.toISOString() });
    const replay = await repository.record(bob.user.id, {
      messageId: message.id, conversationId: conversation.id, kind: "delivered", at: "2026-08-08T11:00:00.000Z",
    });
    expect(replay).toEqual(read);
    expect(await database.select().from(schema.messageReceipts)).toHaveLength(1);

    const denied = new MessageReceiptService(repository, {
      decideForUser: async () => ({ allowed: false }),
    });
    expect(await denied.listVisible(alice.user.id, conversation.id, 0)).toEqual({
      visible: false,
      receipts: [],
    });
    const allowed = new MessageReceiptService(repository, {
      decideForUser: async () => ({ allowed: true }),
    });
    expect(await allowed.listVisible(alice.user.id, conversation.id, 0)).toMatchObject({
      visible: true,
      receipts: [{ messageId: message.id, readAt: NOW.toISOString() }],
    });

    const additionalMessages = await database.insert(schema.messages).values(
      Array.from({ length: 100 }, (_, index) => {
        const sequence = index + 2;
        return {
          conversationId: conversation.id,
          lowUserId: conversation.lowUserId,
          highUserId: conversation.highUserId,
          sequence,
          senderUserId: alice.user.id,
          clientId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
          body: `message ${sequence}`,
        };
      }),
    ).returning();
    await database.insert(schema.messageReceipts).values(additionalMessages.map((row) => ({
      messageId: row.id,
      conversationId: conversation.id,
      userId: bob.user.id,
      deliveredAt: NOW,
      readAt: NOW,
    })));

    const firstPage = await allowed.listVisible(alice.user.id, conversation.id, 0, 100);
    expect(firstPage).toMatchObject({ visible: true, nextAfterSequence: 100 });
    expect(firstPage.receipts).toHaveLength(100);
    const secondPage = await allowed.listVisible(alice.user.id, conversation.id, 100, 100);
    expect(secondPage).toMatchObject({ visible: true, nextAfterSequence: null });
    expect(secondPage.receipts.map(({ sequence }) => sequence)).toEqual([101]);
  });
});
