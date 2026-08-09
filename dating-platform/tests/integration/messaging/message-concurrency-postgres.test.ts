// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { EntitlementService } from "@/modules/entitlements/entitlement-service";
import { UsageRepository } from "@/modules/entitlements/usage-repository";
import { DrizzleMessageVerificationPolicy, MessageRepository } from "@/modules/messaging/message-repository";
import { SocialRepository, type InteractionPolicy } from "@/modules/social/social-repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date("2026-08-08T12:00:00.000Z");
const SECRET = "postgres-messaging-concurrency-secret-at-least-32";

runWithPostgres("messaging PostgreSQL concurrency with independent pools", () => {
  const schemaName = `messaging_test_${randomUUID().replaceAll("-", "")}`;
  let administrationPool: Pool;
  let leftPool: Pool;
  let rightPool: Pool;
  let leftDatabase: ReturnType<typeof drizzle<typeof schema>>;
  let rightDatabase: ReturnType<typeof drizzle<typeof schema>>;
  let leftSocial: SocialRepository;
  let rightSocial: SocialRepository;
  let leftRepository: MessageRepository;
  let rightRepository: MessageRepository;

  const migrateIsolatedSchema = async (client: PoolClient) => {
    await client.query("begin");
    try {
      await client.query(`set local search_path to "${schemaName}"`);
      const names = (await readdir(new URL("../../../drizzle", import.meta.url)))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      for (const name of names) {
        const source = await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8");
        const isolated = source.replaceAll('"public".', `"${schemaName}".`);
        for (const statement of isolated.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
          await client.query(statement);
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  };

  const serviceFor = (database: typeof leftDatabase) => {
    const usage = new UsageRepository(database);
    return new EntitlementService({
      store: usage,
      timeResolver: async () => NOW,
      policyResolver: (tx, userId, key, now) => usage.resolvePolicyInTransaction(tx, userId, key, now),
      planResolver: async () => null,
    });
  };
  const repositoryFor = (
    database: typeof leftDatabase,
    interactionPolicy: InteractionPolicy,
  ) => new MessageRepository(database, {
    interactionPolicy,
    entitlementService: serviceFor(database),
    verificationPolicy: new DrizzleMessageVerificationPolicy(),
    cursorSecret: SECRET,
    clock: () => NOW,
  });

  const addPerson = async (name: string) => {
    const [{ id: userId }] = await leftDatabase.insert(schema.users).values({
      name,
      email: `${schemaName}-${name.toLowerCase().replaceAll(" ", "-")}@example.test`,
      emailVerified: true,
      phoneNumber: `+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      phoneNumberVerified: true,
    }).returning({ id: schema.users.id });
    const [{ id: profileId }] = await leftDatabase.insert(schema.profiles).values({
      userId,
      displayName: name,
      birthDate: "1992-01-01",
      genderCode: "person",
      countryCode: "US",
      timeZone: "UTC",
      status: "active",
      discoverable: true,
    }).returning({ id: schema.profiles.id });
    await leftDatabase.insert(schema.profilePreferences).values({ userId, languageCodes: ["en"] });
    await leftDatabase.insert(schema.privacySettings).values({ userId });
    await leftDatabase.insert(schema.profilePhotos).values({
      userId, profileId, objectKey: `${schemaName}/${profileId}.jpg`, moderationStatus: "approved", position: 0,
    });
    return { userId, profileId };
  };

  const releaseTogether = async (operations: Array<() => Promise<unknown>>) => {
    let release!: () => void;
    let ready = 0;
    let signalReady!: () => void;
    const allReady = new Promise<void>((resolve) => { signalReady = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = operations.map(async (operation) => {
      ready += 1;
      if (ready === operations.length) signalReady();
      await gate;
      return operation();
    });
    await allReady;
    release();
    return Promise.allSettled(running);
  };

  beforeAll(async () => {
    administrationPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await administrationPool.query(`create schema "${schemaName}"`);
    const migrationClient = await administrationPool.connect();
    try { await migrateIsolatedSchema(migrationClient); } finally { migrationClient.release(); }
    const options = { connectionString: TEST_DATABASE_URL, options: `-c search_path=${schemaName}`, max: 2 };
    leftPool = new Pool(options);
    rightPool = new Pool(options);
    leftDatabase = drizzle(leftPool, { schema });
    rightDatabase = drizzle(rightPool, { schema });
    leftSocial = new SocialRepository(leftDatabase, {
      clock: () => NOW, cursorSecret: SECRET, idempotencySecret: SECRET,
    });
    rightSocial = new SocialRepository(rightDatabase, {
      clock: () => NOW, cursorSecret: SECRET, idempotencySecret: SECRET,
    });
    leftRepository = repositoryFor(leftDatabase, leftSocial);
    rightRepository = repositoryFor(rightDatabase, rightSocial);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([leftPool?.end(), rightPool?.end()]);
    if (administrationPool) {
      await administrationPool.query(`drop schema if exists "${schemaName}" cascade`);
      await administrationPool.end();
    }
  });

  it("replays one same-client message across pools without duplicate sequence, outbox, or usage", async () => {
    const alice = await addPerson("PG Message Alice");
    const bob = await addPerson("PG Message Bob");
    const conversation = await leftRepository.createConversation(alice.userId, bob.profileId);
    const input = { clientId: "00000000-0000-4000-8000-000000000201", body: "Same client" };
    const settled = await releaseTogether([
      () => leftRepository.sendMessage(alice.userId, conversation.id, input),
      () => rightRepository.sendMessage(alice.userId, conversation.id, input),
    ]);
    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled[1]).toEqual(fulfilled[0]);
    expect(await leftDatabase.select().from(schema.messages)).toHaveLength(1);
    expect(await leftDatabase.select().from(schema.messageOutboxEvents)).toHaveLength(1);
    expect(await leftDatabase.select().from(schema.entitlementUsageOperations)).toHaveLength(1);
  });

  it("allocates distinct ordered sequences for simultaneous opposite senders", async () => {
    const alice = await addPerson("PG Sequence Alice");
    const bob = await addPerson("PG Sequence Bob");
    const conversation = await leftRepository.createConversation(alice.userId, bob.profileId);
    const settled = await releaseTogether([
      () => leftRepository.sendMessage(alice.userId, conversation.id, {
        clientId: "00000000-0000-4000-8000-000000000202", body: "Left",
      }),
      () => rightRepository.sendMessage(bob.userId, conversation.id, {
        clientId: "00000000-0000-4000-8000-000000000203", body: "Right",
      }),
    ]);
    expect(settled.every(({ status }) => status === "fulfilled")).toBe(true);
    expect((await leftDatabase.select().from(schema.messages)).map(({ sequence }) => sequence).sort())
      .toEqual([1, 2]);
  });

  it("holds a real pair lock through send and rejects all sends after block commits", async () => {
    const alice = await addPerson("PG Block Alice");
    const bob = await addPerson("PG Block Bob");
    const conversation = await leftRepository.createConversation(alice.userId, bob.profileId);
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pausingPolicy: InteractionPolicy = {
      validateRealtimeTicket: leftSocial.validateRealtimeTicket.bind(leftSocial),
      withAllowedProfileInteraction: leftSocial.withAllowedProfileInteraction.bind(leftSocial),
      withSafeViewerRead: leftSocial.withSafeViewerRead.bind(leftSocial),
      safeConversationProfilesInTransaction: leftSocial.safeConversationProfilesInTransaction.bind(leftSocial),
      withAllowedInteraction: (actor, target, write) => leftSocial.withAllowedInteraction(actor, target, async (tx) => {
        signalLocked();
        await gate;
        return write(tx);
      }),
    };
    const pausingRepository = repositoryFor(leftDatabase, pausingPolicy);
    const sending = pausingRepository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000204", body: "Before block",
    });
    await locked;
    const blocking = rightSocial.block(bob.userId, alice.profileId, "pg-message-block");
    const state = await Promise.race([
      blocking.then(() => "finished" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 75)),
    ]);
    expect(state).toBe("pending");
    release();
    await expect(sending).resolves.toMatchObject({ body: "Before block" });
    await blocking;
    await expect(rightRepository.sendMessage(alice.userId, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000205", body: "After block",
    })).rejects.toMatchObject({ code: "CONVERSATION_NOT_AVAILABLE" });
    const [{ value }] = await leftDatabase.select({ value: count() }).from(schema.messages);
    expect(Number(value)).toBe(1);
  });
});
