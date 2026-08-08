// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { EntitlementService } from "@/modules/entitlements/entitlement-service";
import { UsageRepository } from "@/modules/entitlements/usage-repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

runWithPostgres("entitlement PostgreSQL concurrency with independent pools", () => {
  const schemaName = `entitlement_test_${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-08-08T12:00:00Z");
  let administrationPool: Pool;
  let leftPool: Pool;
  let rightPool: Pool;
  let leftDatabase: ReturnType<typeof drizzle<typeof schema>>;
  let rightDatabase: ReturnType<typeof drizzle<typeof schema>>;
  let leftRepository: UsageRepository;
  let rightRepository: UsageRepository;
  let leftService: EntitlementService;
  let rightService: EntitlementService;

  const serviceFor = (repository: UsageRepository) => new EntitlementService({
    store: repository,
    timeResolver: async () => now,
    policyResolver: (transaction, userId, key, at) =>
      repository.resolvePolicyInTransaction(transaction, userId, key, at),
    planResolver: (transaction, userId, at) =>
      repository.resolveActivePlanInTransaction(transaction, userId, at),
  });

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

  const addUser = async (label: string) => {
    const [{ id }] = await leftDatabase.insert(schema.users).values({
      name: label,
      email: `${schemaName}-${label.toLowerCase().replaceAll(" ", "-")}@example.test`,
    }).returning({ id: schema.users.id });
    return id;
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
    leftRepository = new UsageRepository(leftDatabase);
    rightRepository = new UsageRepository(rightDatabase);
    leftService = serviceFor(leftRepository);
    rightService = serviceFor(rightRepository);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([leftPool?.end(), rightPool?.end()]);
    if (administrationPool) {
      await administrationPool.query(`drop schema if exists "${schemaName}" cascade`);
      await administrationPool.end();
    }
  });

  it("lets exactly one independent transaction consume the last allowance", async () => {
    const userId = await addUser("Quota Racer");
    await leftDatabase.insert(schema.entitlementUserOverrides).values({
      userId,
      entitlementKey: "message.send.daily",
      kind: "quota",
      version: 1,
      quotaLimit: 1,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    });
    const consume = (service: EntitlementService, operationId: string) => service.consume({
      userId,
      key: "message.send.daily",
      operationId,
      amount: 1,
      context: {},
    });
    const settled = await releaseTogether([
      () => consume(leftService, "00000000-0000-4000-8000-000000000021"),
      () => consume(rightService, "00000000-0000-4000-8000-000000000022"),
    ]);
    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled.filter((decision) => (decision as { allowed: boolean }).allowed)).toHaveLength(1);
    const [counter] = await leftDatabase.select().from(schema.entitlementUsageCounters)
      .where(eq(schema.entitlementUsageCounters.userId, userId));
    expect(counter.used).toBe(1);
  });

  it("allows one owner for a globally unique operation ID across pools", async () => {
    const leftUserId = await addUser("Operation Left");
    const rightUserId = await addUser("Operation Right");
    const operationId = "00000000-0000-4000-8000-000000000023";
    const settled = await releaseTogether([
      () => leftService.consume({
        userId: leftUserId, key: "message.send.daily", operationId, amount: 1,
        context: { side: "left" },
      }),
      () => rightService.consume({
        userId: rightUserId, key: "message.send.daily", operationId, amount: 1,
        context: { side: "right" },
      }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain("OPERATION_ID_CONFLICT");
    expect(await leftDatabase.select().from(schema.entitlementUsageOperations)
      .where(eq(schema.entitlementUsageOperations.operationId, operationId))).toHaveLength(1);
  });

  it("replays the same operation and rolls caller transactions back atomically", async () => {
    const userId = await addUser("Replay Owner");
    const input = {
      userId,
      key: "message.send.daily" as const,
      operationId: "00000000-0000-4000-8000-000000000024",
      amount: 1,
      context: { conversationId: "same-operation" },
    };
    const first = await leftService.consume(input);
    await expect(rightService.consume(input)).resolves.toEqual(first);

    await expect(leftDatabase.transaction(async (transaction) => {
      await leftService.consumeInTransaction(transaction, {
        ...input,
        operationId: "00000000-0000-4000-8000-000000000025",
      });
      throw new Error("CALLER_ROLLBACK");
    })).rejects.toThrow("CALLER_ROLLBACK");
    expect(await leftDatabase.select().from(schema.entitlementUsageOperations)
      .where(eq(schema.entitlementUsageOperations.operationId,
        "00000000-0000-4000-8000-000000000025"))).toHaveLength(0);
  });

  it("replays concurrent identical operations from two independent pools", async () => {
    const userId = await addUser("Concurrent Replay Owner");
    await leftDatabase.insert(schema.entitlementUserOverrides).values({
      userId,
      entitlementKey: "message.send.daily",
      kind: "quota",
      version: 1,
      quotaLimit: 2,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    });
    const input = {
      userId,
      key: "message.send.daily" as const,
      operationId: "00000000-0000-4000-8000-000000000026",
      amount: 1,
      context: { conversationId: "two-pool-replay" },
    };
    const settled = await releaseTogether([
      () => leftService.consume(input),
      () => rightService.consume(input),
    ]);
    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled[1]).toEqual(fulfilled[0]);
    expect(await leftDatabase.select().from(schema.entitlementUsageOperations)
      .where(eq(schema.entitlementUsageOperations.operationId, input.operationId))).toHaveLength(1);
    const [counter] = await leftDatabase.select().from(schema.entitlementUsageCounters)
      .where(eq(schema.entitlementUsageCounters.userId, userId));
    expect(counter.used).toBe(1);
  });
});
