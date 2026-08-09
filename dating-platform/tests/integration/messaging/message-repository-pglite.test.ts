// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { EntitlementService } from "@/modules/entitlements/entitlement-service";
import { UsageRepository } from "@/modules/entitlements/usage-repository";
import {
  DrizzleMessageVerificationPolicy,
  MessageRepository,
} from "@/modules/messaging/message-repository";
import { SocialRepository, type InteractionPolicy } from "@/modules/social/social-repository";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const SECRET = "messaging-cursor-secret-that-is-long-enough";

describe("message repository", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let social: SocialRepository;
  let entitlementService: EntitlementService;
  let repository: MessageRepository;

  const addPerson = async (name: string, verified = true) => {
    const [{ id: userId }] = await database.insert(schema.users).values({
      name,
      email: `${name.toLowerCase().replaceAll(" ", "-")}@example.test`,
      emailVerified: verified,
      phoneNumber: `+1206555${Math.floor(Math.random() * 8999 + 1000)}`,
      phoneNumberVerified: verified,
    }).returning({ id: schema.users.id });
    const [{ id: profileId }] = await database.insert(schema.profiles).values({
      userId,
      displayName: name,
      birthDate: "1992-01-01",
      genderCode: "person",
      relationshipGoalCode: "long_term",
      countryCode: "US",
      timeZone: "UTC",
      city: "Seattle",
      bio: "Public bio",
      status: "active",
      discoverable: true,
      publishRequested: true,
    }).returning({ id: schema.profiles.id });
    await database.insert(schema.profilePreferences).values({
      userId,
      languageCodes: ["en"],
      relationshipGoalCodes: ["long_term"],
    });
    await database.insert(schema.privacySettings).values({ userId, locationPrecision: "country" });
    await database.insert(schema.profilePhotos).values({
      userId,
      profileId,
      objectKey: `messaging/${userId}/${profileId}.jpg`,
      moderationStatus: "approved",
      position: 0,
      width: 800,
      height: 1000,
    });
    return { userId, profileId };
  };

  const match = async (leftUserId: string, rightUserId: string) => {
    const [lowUserId, highUserId] = [leftUserId, rightUserId].sort();
    await database.insert(schema.socialMatches).values({ lowUserId, highUserId, status: "active" });
  };

  const makeRepository = (interactionPolicy: InteractionPolicy = social) => new MessageRepository(database, {
    interactionPolicy,
    entitlementService,
    verificationPolicy: new DrizzleMessageVerificationPolicy(),
    cursorSecret: SECRET,
    clock: () => NOW,
  });

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    social = new SocialRepository(database, {
      clock: () => NOW,
      cursorSecret: SECRET,
      idempotencySecret: SECRET,
    });
    const usage = new UsageRepository(database);
    entitlementService = new EntitlementService({
      store: usage,
      timeResolver: async () => NOW,
      policyResolver: (tx, userId, key, now) => usage.resolvePolicyInTransaction(tx, userId, key, now),
      planResolver: async () => null,
    });
    repository = makeRepository();
  });

  afterEach(async () => client.close());

  it("creates one canonical conversation for an eligible unmatched profile and rejects hidden or blocked targets", async () => {
    const alice = await addPerson("Create Alice");
    const bob = await addPerson("Create Bob");
    const [first, replay] = await Promise.all([
      repository.createConversation(alice.userId, bob.profileId),
      repository.createConversation(alice.userId, bob.profileId),
    ]);
    expect(replay).toEqual(first);
    expect(await database.select().from(schema.conversations)).toHaveLength(1);
    expect(await database.select().from(schema.conversationMembers)).toHaveLength(2);

    const hidden = await addPerson("Create Hidden");
    await database.update(schema.profiles).set({ discoverable: false })
      .where(eq(schema.profiles.id, hidden.profileId));
    await expect(repository.createConversation(alice.userId, hidden.profileId))
      .rejects.toMatchObject({ code: "CONVERSATION_NOT_AVAILABLE" });
    const blocked = await addPerson("Create Blocked");
    await social.block(blocked.userId, alice.profileId, "create-block-key");
    await expect(repository.createConversation(alice.userId, blocked.profileId))
      .rejects.toMatchObject({ code: "CONVERSATION_NOT_AVAILABLE" });

    const unverified = await addPerson("Create Unverified", false);
    const verificationTarget = await addPerson("Create Verification Target");
    await expect(repository.createConversation(unverified.userId, verificationTarget.profileId))
      .rejects.toMatchObject({ code: "VERIFICATION_REQUIRED", unmet: ["email", "phone"] });
    const quotaOwner = await addPerson("Create Quota Owner");
    const quotaTarget = await addPerson("Create Quota Target");
    await database.insert(schema.entitlementUserOverrides).values({
      userId: quotaOwner.userId,
      entitlementKey: "message.send.daily",
      version: 1,
      kind: "quota",
      quotaLimit: 0,
      effectiveAt: NOW,
    });
    await expect(repository.createConversation(quotaOwner.userId, quotaTarget.profileId))
      .rejects.toMatchObject({ code: "MESSAGE_SEND_DENIED" });
    expect(await database.select().from(schema.entitlementUsageOperations)).toEqual([]);
  });

  it("stores one message and one body-free outbox event for a retried client id", async () => {
    const alice = await addPerson("Idempotent Alice");
    const bob = await addPerson("Idempotent Bob");
    await match(alice.userId, bob.userId);
    const conversation = await repository.createConversation(alice.userId, bob.profileId);
    const clientId = "00000000-0000-4000-8000-000000000111";

    const first = await repository.sendMessage(alice.userId, conversation.id, { clientId, body: "Hello 👋" });
    const replay = await repository.sendMessage(alice.userId, conversation.id, { clientId, body: "Hello 👋" });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ sender: "me" });
    expect(first).not.toHaveProperty("senderUserId");
    expect(await database.select().from(schema.messages)).toHaveLength(1);
    const [event] = await database.select().from(schema.messageOutboxEvents);
    expect(event).toMatchObject({ messageId: first.id, eventType: "message.created", status: "pending" });
    expect(JSON.stringify(event.payload)).not.toContain("Hello");
    expect(Object.keys(event.payload).sort()).toEqual([
      "conversationId", "messageId", "senderUserId", "sequence",
    ]);

    await expect(repository.sendMessage(alice.userId, conversation.id, { clientId, body: "Changed" }))
      .rejects.toMatchObject({ code: "MESSAGE_IDEMPOTENCY_CONFLICT" });
  });

  it("replays a successful message before time-varying verification and entitlement checks", async () => {
    const alice = await addPerson("Replay Alice");
    const bob = await addPerson("Replay Bob");
    await match(alice.userId, bob.userId);
    const conversation = await repository.createConversation(alice.userId, bob.profileId);
    const input = { clientId: "00000000-0000-4000-8000-000000000112", body: "Stable" };
    const first = await repository.sendMessage(alice.userId, conversation.id, input);
    await database.update(schema.users).set({ phoneNumberVerified: false }).where(eq(schema.users.id, alice.userId));
    await database.insert(schema.entitlementUserOverrides).values({
      userId: alice.userId,
      entitlementKey: "message.send.daily",
      version: 1,
      kind: "quota",
      quotaLimit: 0,
      effectiveAt: NOW,
    });
    await expect(repository.sendMessage(alice.userId, conversation.id, input)).resolves.toEqual(first);
  });

  it("rejects cross-conversation client-id reuse without consuming twice", async () => {
    const alice = await addPerson("Cross Alice");
    const bob = await addPerson("Cross Bob");
    const charlie = await addPerson("Cross Charlie");
    await match(alice.userId, bob.userId);
    await match(alice.userId, charlie.userId);
    const firstConversation = await repository.createConversation(alice.userId, bob.profileId);
    const secondConversation = await repository.createConversation(alice.userId, charlie.profileId);
    const clientId = "00000000-0000-4000-8000-000000000113";
    await repository.sendMessage(alice.userId, firstConversation.id, { clientId, body: "First" });
    await expect(repository.sendMessage(alice.userId, secondConversation.id, { clientId, body: "First" }))
      .rejects.toMatchObject({ code: "MESSAGE_IDEMPOTENCY_CONFLICT" });
    expect(await database.select().from(schema.messages)).toHaveLength(1);
    expect(await database.select().from(schema.entitlementUsageOperations)).toHaveLength(1);
  });

  it("checks membership, verification, and entitlement and rolls every denial back", async () => {
    const alice = await addPerson("Policy Alice");
    const bob = await addPerson("Policy Bob");
    const outsider = await addPerson("Policy Outsider");
    await match(alice.userId, bob.userId);
    const conversation = await repository.createConversation(alice.userId, bob.profileId);
    await database.update(schema.users).set({ emailVerified: false, phoneNumberVerified: false })
      .where(eq(schema.users.id, alice.userId));

    await expect(repository.sendMessage(outsider.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000114", body: "No access",
    })).rejects.toMatchObject({ code: "CONVERSATION_NOT_AVAILABLE" });
    await expect(repository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000115", body: "Unverified",
    })).rejects.toMatchObject({ code: "VERIFICATION_REQUIRED", unmet: ["email", "phone"] });
    expect(await database.select().from(schema.entitlementUsageOperations)).toEqual([]);

    await database.update(schema.users).set({ emailVerified: true, phoneNumberVerified: true })
      .where(eq(schema.users.id, alice.userId));
    await database.insert(schema.entitlementUserOverrides).values({
      userId: alice.userId,
      entitlementKey: "message.send.daily",
      version: 1,
      kind: "quota",
      quotaLimit: 0,
      effectiveAt: NOW,
    });
    await expect(repository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000116", body: "No quota",
    })).rejects.toMatchObject({ code: "MESSAGE_SEND_DENIED" });
    expect(await database.select().from(schema.messages)).toEqual([]);
    expect(await database.select().from(schema.entitlementUsageOperations)).toEqual([]);
    expect(await database.select().from(schema.entitlementUsageCounters)).toEqual([]);
  });

  it("rolls entitlement and message writes back when outbox append fails", async () => {
    const alice = await addPerson("Rollback Alice");
    const bob = await addPerson("Rollback Bob");
    await match(alice.userId, bob.userId);
    const conversation = await repository.createConversation(alice.userId, bob.profileId);
    await client.exec(`
      CREATE FUNCTION reject_message_outbox() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'OUTBOX_UNAVAILABLE'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_message_outbox BEFORE INSERT ON message_outbox_events
      FOR EACH ROW EXECUTE FUNCTION reject_message_outbox();
    `);
    await expect(repository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000117", body: "Rollback",
    })).rejects.toThrow();
    expect(await database.select().from(schema.messages)).toEqual([]);
    expect(await database.select().from(schema.entitlementUsageOperations)).toEqual([]);
    const [row] = await database.select().from(schema.conversations);
    expect(row.nextSequence).toBe(1);
  });

  it("allocates stable increasing sequences and returns bounded member-only history", async () => {
    const alice = await addPerson("Sequence Alice");
    const bob = await addPerson("Sequence Bob");
    const outsider = await addPerson("Sequence Outsider");
    await match(alice.userId, bob.userId);
    const conversation = await repository.createConversation(alice.userId, bob.profileId);
    await Promise.all([
      repository.sendMessage(alice.userId, conversation.id, {
        clientId: "00000000-0000-4000-8000-000000000118", body: "One",
      }),
      repository.sendMessage(bob.userId, conversation.id, {
        clientId: "00000000-0000-4000-8000-000000000119", body: "Two",
      }),
    ]);
    const page = await repository.listMessages(alice.userId, conversation.id, { afterSequence: 0, pageSize: 1 });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.sequence).toBe(1);
    expect(page.nextAfterSequence).toBe(1);
    expect((await repository.listMessages(alice.userId, conversation.id, {
      afterSequence: page.nextAfterSequence!, pageSize: 10,
    })).messages[0]?.sequence).toBe(2);
    await expect(repository.listMessages(outsider.userId, conversation.id, { afterSequence: 0, pageSize: 10 }))
      .rejects.toMatchObject({ code: "CONVERSATION_NOT_AVAILABLE" });
  });

  it("linearizes a send against block and rejects every send after block completion", async () => {
    const alice = await addPerson("Race Alice");
    const bob = await addPerson("Race Bob");
    await match(alice.userId, bob.userId);
    const conversation = await repository.createConversation(alice.userId, bob.profileId);
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pausingPolicy: InteractionPolicy = {
      validateRealtimeTicket: social.validateRealtimeTicket.bind(social),
      withAllowedInteraction: (actor, target, write) => social.withAllowedInteraction(actor, target, async (tx) => {
        signalLocked();
        await gate;
        return write(tx);
      }),
      withAllowedProfileInteraction: social.withAllowedProfileInteraction.bind(social),
      withSafeViewerRead: social.withSafeViewerRead.bind(social),
      safeConversationProfilesInTransaction: social.safeConversationProfilesInTransaction.bind(social),
    };
    const pausingRepository = makeRepository(pausingPolicy);
    const sending = pausingRepository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000120", body: "Before block",
    });
    await locked;
    const blocking = social.block(bob.userId, alice.profileId, "messaging-race-block");
    const state = await Promise.race([
      blocking.then(() => "finished" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(state).toBe("pending");
    release();
    await expect(sending).resolves.toMatchObject({ body: "Before block" });
    await blocking;
    await expect(repository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000121", body: "After block",
    })).rejects.toMatchObject({ code: "CONVERSATION_NOT_AVAILABLE" });
    const [{ value }] = await database.select({ value: count() }).from(schema.messages);
    expect(Number(value)).toBe(1);
  });

  it("keeps an existing active conversation sendable when only discoverability is disabled", async () => {
    const alice = await addPerson("Hidden Conversation Alice");
    const bob = await addPerson("Hidden Conversation Bob");
    const conversation = await repository.createConversation(alice.userId, bob.profileId);
    await database.update(schema.profiles).set({ discoverable: false })
      .where(eq(schema.profiles.id, bob.profileId));
    await expect(repository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000122",
      body: "Existing conversation",
    })).resolves.toMatchObject({ body: "Existing conversation" });
    expect((await repository.listConversations(alice.userId, { pageSize: 20 })).conversations)
      .toHaveLength(1);

    await database.update(schema.profiles).set({ status: "restricted" })
      .where(eq(schema.profiles.id, bob.profileId));
    await expect(repository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000123",
      body: "Restricted recipient",
    })).rejects.toMatchObject({ code: "CONVERSATION_NOT_AVAILABLE" });
  });

  it("lists only safe counterpart projections and hides blocked conversations", async () => {
    const alice = await addPerson("List Alice");
    const bob = await addPerson("List Bob");
    await match(alice.userId, bob.userId);
    const conversation = await repository.createConversation(alice.userId, bob.profileId);
    const page = await repository.listConversations(alice.userId, { pageSize: 20 });
    expect(page.conversations).toHaveLength(1);
    expect(page.conversations[0]).toMatchObject({ id: conversation.id, profile: { id: bob.profileId } });
    expect(page.conversations[0]?.profile).not.toHaveProperty("userId");
    expect(page.conversations[0]?.profile).not.toHaveProperty("birthDate");
    expect(page.conversations[0]?.profile).not.toHaveProperty("city");
    await database.update(schema.conversationMembers).set({ hiddenAt: NOW }).where(eq(
      schema.conversationMembers.userId,
      alice.userId,
    ));
    expect((await repository.listConversations(alice.userId, { pageSize: 20 })).conversations).toEqual([]);
    await database.update(schema.conversationMembers).set({ hiddenAt: null }).where(eq(
      schema.conversationMembers.userId,
      alice.userId,
    ));
    await social.block(alice.userId, bob.profileId, "conversation-list-block");
    expect((await repository.listConversations(alice.userId, { pageSize: 20 })).conversations).toEqual([]);
  });
});
