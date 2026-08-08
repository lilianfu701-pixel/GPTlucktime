// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { SocialOutboxDispatcher } from "@/modules/social/social-outbox-dispatcher";
import {
  SocialRepository,
  type SocialTransaction,
} from "@/modules/social/social-repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;
const SECRET = "postgres-social-concurrency-secret-at-least-thirty-two";

runWithPostgres("social PostgreSQL concurrency with independent pools", () => {
  const schemaName = `social_test_${randomUUID().replaceAll("-", "")}`;
  let administrationPool: Pool;
  let leftPool: Pool;
  let rightPool: Pool;
  let leftDatabase: ReturnType<typeof drizzle<typeof schema>>;
  let rightDatabase: ReturnType<typeof drizzle<typeof schema>>;
  let leftRepository: SocialRepository;
  let rightRepository: SocialRepository;
  let leftDispatcher: SocialOutboxDispatcher;
  const now = new Date("2026-08-08T12:00:00Z");

  const releaseTogether = async (operations: Array<() => Promise<unknown>>) => {
    let release!: () => void;
    let readyCount = 0;
    let signalAllReady!: () => void;
    const allReady = new Promise<void>((resolve) => { signalAllReady = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = operations.map(async (operation) => {
      readyCount += 1;
      if (readyCount === operations.length) signalAllReady();
      await gate;
      return operation();
    });
    await allReady;
    try {
      release();
      return await Promise.allSettled(running);
    } finally {
      release();
    }
  };

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

  const addPerson = async (name: string) => {
    const [{ id: userId }] = await leftDatabase.insert(schema.users).values({
      name,
      email: `${schemaName}-${name.toLowerCase().replaceAll(" ", "-")}@example.test`,
    }).returning({ id: schema.users.id });
    const [{ id: profileId }] = await leftDatabase.insert(schema.profiles).values({
      userId,
      displayName: name,
      birthDate: "1992-01-01",
      genderCode: "woman",
      countryCode: "US",
      timeZone: "UTC",
      city: "Seattle",
      bio: "Public bio",
      status: "active",
      discoverable: true,
    }).returning({ id: schema.profiles.id });
    await leftDatabase.insert(schema.profilePreferences).values({ userId, languageCodes: ["en"] });
    await leftDatabase.insert(schema.privacySettings).values({ userId, locationPrecision: "country" });
    await leftDatabase.insert(schema.profilePhotos).values({
      userId,
      profileId,
      objectKey: `${schemaName}/${userId}/${profileId}.jpg`,
      moderationStatus: "approved",
      position: 0,
    });
    return { userId, profileId };
  };

  beforeAll(async () => {
    administrationPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await administrationPool.query(`create schema "${schemaName}"`);
    const migrationClient = await administrationPool.connect();
    try {
      await migrateIsolatedSchema(migrationClient);
    } finally {
      migrationClient.release();
    }
    const poolOptions = { connectionString: TEST_DATABASE_URL, options: `-c search_path=${schemaName}`, max: 2 };
    leftPool = new Pool(poolOptions);
    rightPool = new Pool(poolOptions);
    leftDatabase = drizzle(leftPool, { schema });
    rightDatabase = drizzle(rightPool, { schema });
    leftRepository = new SocialRepository(leftDatabase, {
      clock: () => now, cursorSecret: SECRET, idempotencySecret: SECRET,
    });
    rightRepository = new SocialRepository(rightDatabase, {
      clock: () => now, cursorSecret: SECRET, idempotencySecret: SECRET,
    });
    leftDispatcher = new SocialOutboxDispatcher(leftDatabase, { clock: () => now, sendTimeoutMs: 5_000 });
  }, 30_000);

  afterAll(async () => {
    await Promise.all([leftPool?.end(), rightPool?.end()]);
    if (administrationPool) {
      await administrationPool.query(`drop schema if exists "${schemaName}" cascade`);
      await administrationPool.end();
    }
  });

  it("creates one match and event for reciprocal likes on separate pools", async () => {
    const alice = await addPerson("PG Reciprocal Alice");
    const bob = await addPerson("PG Reciprocal Bob");
    await releaseTogether([
      () => leftRepository.like(alice.userId, bob.profileId, "pg-reciprocal-a"),
      () => rightRepository.like(bob.userId, alice.profileId, "pg-reciprocal-b"),
    ]);
    expect(await leftDatabase.select().from(schema.socialMatches)).toHaveLength(1);
    expect(await leftDatabase.select().from(schema.socialOutboxEvents)).toHaveLength(1);
  });

  it("allows only one target for the same actor idempotency key across pools", async () => {
    const alice = await addPerson("PG Key Alice");
    const bob = await addPerson("PG Key Bob");
    const charlie = await addPerson("PG Key Charlie");
    const results = await releaseTogether([
      () => leftRepository.like(alice.userId, bob.profileId, "pg-shared-key"),
      () => rightRepository.like(alice.userId, charlie.profileId, "pg-shared-key"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await leftDatabase.select().from(schema.socialActionIdempotency)
      .where(eq(schema.socialActionIdempotency.actorUserId, alice.userId))).toHaveLength(1);
  });

  it("never leaves a visible match when reciprocal like races block across pools", async () => {
    const alice = await addPerson("PG Race Alice");
    const bob = await addPerson("PG Race Bob");
    await leftRepository.like(alice.userId, bob.profileId, "pg-race-first-like");
    await releaseTogether([
      () => rightRepository.like(bob.userId, alice.profileId, "pg-race-reciprocal"),
      () => leftRepository.block(alice.userId, bob.profileId, "pg-race-block"),
    ]);
    const active = await leftDatabase.select().from(schema.socialMatches).where(and(
      eq(schema.socialMatches.status, "active"),
      eq(schema.socialMatches.lowUserId, [alice.userId, bob.userId].sort()[0]!),
      eq(schema.socialMatches.highUserId, [alice.userId, bob.userId].sort()[1]!),
    ));
    expect(active).toEqual([]);
  });

  it("holds pair locks through sender completion before block can commit", async () => {
    const alice = await addPerson("PG Dispatch Alice");
    const bob = await addPerson("PG Dispatch Bob");
    await leftRepository.like(alice.userId, bob.profileId, "pg-dispatch-like-a");
    const matched = await rightRepository.like(bob.userId, alice.profileId, "pg-dispatch-like-b");
    const [event] = await leftDatabase.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.aggregateId, matched.matchId!));
    let releaseSender!: () => void;
    let signalSenderStarted!: () => void;
    let signalBlockLockAttempted!: () => void;
    const senderStarted = new Promise<void>((resolve) => { signalSenderStarted = resolve; });
    const senderReleased = new Promise<void>((resolve) => { releaseSender = resolve; });
    const blockLockAttempted = new Promise<void>((resolve) => { signalBlockLockAttempted = resolve; });
    const sender = vi.fn(async () => {
      signalSenderStarted();
      await senderReleased;
    });
    type LockPairUsers = (
      transaction: SocialTransaction,
      leftUserId: string,
      rightUserId: string,
    ) => Promise<void>;
    const internals = rightRepository as unknown as { lockPairUsers: LockPairUsers };
    const originalLock = internals.lockPairUsers.bind(rightRepository);
    const lockProbe = vi.spyOn(internals, "lockPairUsers").mockImplementationOnce((...args) => {
      const locking = originalLock(...args);
      signalBlockLockAttempted();
      return locking;
    });

    const dispatching = leftDispatcher.dispatch(event!.id, sender);
    await senderStarted;
    let blockFinished = false;
    const blocking = rightRepository.block(alice.userId, bob.profileId, "pg-dispatch-block")
      .finally(() => { blockFinished = true; });
    try {
      await blockLockAttempted;
      const blockState = await Promise.race([
        blocking.then(() => "finished" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 75)),
      ]);
      expect(blockState).toBe("pending");
      expect(blockFinished).toBe(false);
    } finally {
      releaseSender();
    }
    await expect(dispatching).resolves.toEqual({ status: "published" });
    await expect(blocking).resolves.toEqual({ blocked: true });
    expect(sender).toHaveBeenCalledOnce();
    lockProbe.mockRestore();
  });

  it("never invokes the sender when block commits before dispatch on separate pools", async () => {
    const alice = await addPerson("PG Block First Alice");
    const bob = await addPerson("PG Block First Bob");
    await leftRepository.like(alice.userId, bob.profileId, "pg-block-first-like-a");
    const matched = await rightRepository.like(bob.userId, alice.profileId, "pg-block-first-like-b");
    const [event] = await leftDatabase.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.aggregateId, matched.matchId!));
    await rightRepository.block(alice.userId, bob.profileId, "pg-block-first-block");
    const sender = vi.fn(async () => undefined);

    await expect(leftDispatcher.dispatch(event!.id, sender)).resolves.toEqual({ status: "suppressed" });
    expect(sender).not.toHaveBeenCalled();
  });
});
