// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { EntitlementService, resolveEntitlement } from "@/modules/entitlements/entitlement-service";
import { UsageRepository } from "@/modules/entitlements/usage-repository";

const NOW = new Date("2026-08-08T12:00:00Z");
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000099";

describe("entitlement usage repository", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let repository: UsageRepository;
  let service: EntitlementService;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    [{ id: userId }] = await database.insert(schema.users).values({
      name: "Entitled User",
      email: "entitled@example.test",
    }).returning({ id: schema.users.id });
    repository = new UsageRepository(database);
    service = new EntitlementService({
      store: repository,
      timeResolver: async () => NOW,
      policyResolver: (transaction, ownerId, key, now) =>
        repository.resolvePolicyInTransaction(transaction, ownerId, key, now),
      planResolver: (transaction, ownerId, now) =>
        repository.resolveActivePlanInTransaction(transaction, ownerId, now),
    });
  });

  afterEach(async () => client.close());

  it("seeds core free defaults without overwriting version history", async () => {
    const rows = await database.select().from(schema.entitlementConfigurations);
    expect(rows).toHaveLength(9);
    expect(rows.map((row) => row.entitlementKey).sort()).toEqual([
      "likes.received.view",
      "message.read_receipt.view",
      "message.send.daily",
      "profile.incognito.use",
      "profile.visitors.view",
      "ranking.boost.multiplier",
      "search.advanced.use",
      "super_like.monthly",
      "translation.message.use",
    ]);
    expect(rows.every((row) => row.version === 1 && row.scope === "free_default")).toBe(true);
  });

  it("keeps launch core features open and non-core defaults at zero or one", async () => {
    const decide = async (key: Parameters<UsageRepository["resolve"]>[0]["key"]) => resolveEntitlement({
      key,
      sources: await repository.resolve({ userId, key, planRef: null, now: NOW }),
      policy: { safetyAllowed: true, verificationSatisfied: true },
      now: NOW,
    });
    expect(await decide("message.send.daily")).toMatchObject({ allowed: true, limit: null, remaining: null });
    for (const key of [
      "message.read_receipt.view", "search.advanced.use", "likes.received.view",
      "profile.visitors.view", "profile.incognito.use",
    ] as const) {
      expect(await decide(key)).toMatchObject({ allowed: true, kind: "boolean", value: true });
    }
    expect(await decide("translation.message.use")).toMatchObject({
      allowed: false, limit: 0, remaining: 0, reason: "NOT_INCLUDED",
    });
    expect(await decide("ranking.boost.multiplier")).toMatchObject({
      allowed: true, kind: "numeric", value: 1,
    });
    expect(await decide("super_like.monthly")).toMatchObject({
      allowed: false, limit: 0, remaining: 0, reason: "NOT_INCLUDED",
    });
  });

  it("resolves valid user overrides before active plan benefits and ignores expiry", async () => {
    await database.insert(schema.entitlementPlanBenefits).values({
      planRef: "plus-v1",
      entitlementKey: "super_like.monthly",
      kind: "quota",
      version: 1,
      enabled: true,
      quotaLimit: 5,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    });
    await database.insert(schema.entitlementUserOverrides).values([{
      userId,
      entitlementKey: "super_like.monthly",
      kind: "quota",
      version: 1,
      enabled: true,
      quotaLimit: 7,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-08-09T00:00:00Z"),
    }, {
      userId,
      entitlementKey: "message.send.daily",
      kind: "quota",
      version: 1,
      enabled: true,
      quotaLimit: 1,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-08-08T00:00:00Z"),
    }]);

    const override = await repository.resolve({
      userId, key: "super_like.monthly", planRef: "plus-v1", now: NOW,
    });
    expect(override.userOverride?.quotaLimit).toBe(7);
    expect(override.planBenefit?.quotaLimit).toBe(5);
    const expired = await repository.resolve({
      userId, key: "message.send.daily", planRef: null, now: NOW,
    });
    expect(expired.userOverride).toBeNull();
    expect(expired.freeDefault?.quotaLimit).toBeNull();
  });

  it("ignores expired plans and applies the newest effective global switch", async () => {
    await database.insert(schema.entitlementPlanBenefits).values({
      planRef: "expired-plus",
      entitlementKey: "super_like.monthly",
      kind: "quota",
      version: 1,
      quotaLimit: 5,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-08-08T00:00:00Z"),
    });
    await database.insert(schema.entitlementConfigurations).values([{
      entitlementKey: "message.send.daily",
      scope: "global_flag",
      version: 1,
      kind: "quota",
      enabled: true,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    }, {
      entitlementKey: "message.send.daily",
      scope: "global_flag",
      version: 2,
      kind: "quota",
      enabled: false,
      effectiveAt: new Date("2026-08-02T00:00:00Z"),
    }]);
    expect((await repository.resolve({
      userId, key: "super_like.monthly", planRef: "expired-plus", now: NOW,
    })).planBenefit).toBeNull();
    expect((await repository.resolve({
      userId, key: "message.send.daily", planRef: null, now: NOW,
    })).globalEnabled).toBe(false);
  });

  it("replays a unique operation without double consumption and rejects cross-scope reuse", async () => {
    const operationId = "00000000-0000-4000-8000-000000000010";
    await database.insert(schema.entitlementUserOverrides).values({
      userId,
      entitlementKey: "message.send.daily",
      kind: "quota",
      version: 1,
      enabled: true,
      quotaLimit: 2,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    });
    const input = {
      userId,
      key: "message.send.daily" as const,
      operationId,
      amount: 1,
      context: { conversationId: "conversation-a" },
    };
    const first = await service.consume(input);
    const replay = await service.consume(input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    const [usage] = await database.select().from(schema.entitlementUsageCounters);
    expect(usage.used).toBe(1);

    await expect(service.consume({ ...input, userId: OTHER_USER_ID }))
      .rejects.toThrow("OPERATION_ID_CONFLICT");
    await expect(service.consume({ ...input, key: "super_like.monthly" }))
      .rejects.toThrow("OPERATION_ID_CONFLICT");
    await expect(service.consume({ ...input, context: { conversationId: "conversation-b" } }))
      .rejects.toThrow("OPERATION_ID_CONFLICT");
  });

  it("allows only one winner for the last concurrent allowance", async () => {
    await database.insert(schema.entitlementUserOverrides).values({
      userId,
      entitlementKey: "message.send.daily",
      kind: "quota",
      version: 1,
      enabled: true,
      quotaLimit: 1,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    });
    const consume = (operationId: string) => service.consume({
      userId,
      key: "message.send.daily",
      operationId,
      amount: 1,
      context: {},
    });

    const results = await Promise.all([
      consume("00000000-0000-4000-8000-000000000011"),
      consume("00000000-0000-4000-8000-000000000012"),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    const [usage] = await database.select().from(schema.entitlementUsageCounters)
      .where(eq(schema.entitlementUsageCounters.userId, userId));
    expect(usage.used).toBe(1);
    const [{ value: operationCount }] = await database.select({ value: count() })
      .from(schema.entitlementUsageOperations);
    expect(operationCount).toBe(2);
  });

  it("coalesces concurrent identical operations behind a controlled barrier", async () => {
    let signalArrival!: () => void;
    const arrived = new Promise<void>((resolve) => { signalArrival = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const barrierRepository = new UsageRepository(database);
    const barrierStore = {
      transaction: async (work: (transaction: unknown) => Promise<unknown>) => {
        signalArrival();
        await gate;
        return barrierRepository.transaction(work);
      },
      resolveInTransaction: barrierRepository.resolveInTransaction.bind(barrierRepository),
      consumeResolvedInTransaction:
        barrierRepository.consumeResolvedInTransaction.bind(barrierRepository),
    } as never;
    const barrierService = new EntitlementService({
      store: barrierStore,
      timeResolver: async () => NOW,
      policyResolver: (transaction, ownerId, key, now) =>
        barrierRepository.resolvePolicyInTransaction(transaction, ownerId, key, now),
      planResolver: async () => null,
    });
    await database.insert(schema.entitlementUserOverrides).values({
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
      operationId: "00000000-0000-4000-8000-000000000085",
      amount: 1,
      context: { conversationId: "controlled-barrier" },
    };
    const first = barrierService.consume(input);
    await arrived;
    const second = barrierService.consume(input);
    release();
    const decisions = await Promise.all([first, second]);
    expect(decisions[1]).toEqual(decisions[0]);
    expect(decisions[0]).toMatchObject({ allowed: true, remaining: 1 });
    expect((await database.select().from(schema.entitlementUsageCounters))[0]?.used).toBe(1);
    expect(await database.select().from(schema.entitlementUsageOperations)).toHaveLength(1);
    await expect(barrierService.consume({ ...input, context: { conversationId: "different" } }))
      .rejects.toThrow("OPERATION_ID_CONFLICT");
  });

  it("does not consume a partial allowance when the requested amount is too large", async () => {
    await database.insert(schema.entitlementUserOverrides).values({
      userId,
      entitlementKey: "message.send.daily",
      kind: "quota",
      version: 1,
      quotaLimit: 1,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    });
    const result = await service.consume({
      userId,
      key: "message.send.daily",
      operationId: "00000000-0000-4000-8000-000000000013",
      amount: 2,
      context: {},
    });
    expect(result).toMatchObject({ allowed: false, remaining: 1, reason: "LIMIT_REACHED" });
    const [usage] = await database.select().from(schema.entitlementUsageCounters);
    expect(usage.used).toBe(0);
  });

  it("accepts the exact quota ceiling without overflow and rejects amounts above it", async () => {
    await database.insert(schema.entitlementUserOverrides).values({
      userId,
      entitlementKey: "message.send.daily",
      kind: "quota",
      version: 1,
      quotaLimit: 1_000_000,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    });
    await database.insert(schema.entitlementUsageCounters).values({
      userId,
      entitlementKey: "message.send.daily",
      periodStart: new Date("2026-08-08T00:00:00Z"),
      resetAt: new Date("2026-08-09T00:00:00Z"),
      used: 999_999,
      updatedAt: NOW,
    });
    await expect(service.consume({
      userId,
      key: "message.send.daily",
      operationId: "00000000-0000-4000-8000-000000000080",
      amount: 1,
      context: {},
    })).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(service.consume({
      userId,
      key: "message.send.daily",
      operationId: "00000000-0000-4000-8000-000000000081",
      amount: 1_000_001,
      context: {},
    })).rejects.toThrow("INVALID_ENTITLEMENT_AMOUNT");
  });

  it("records a disabled decision without creating a usage counter", async () => {
    await database.insert(schema.entitlementConfigurations).values({
      entitlementKey: "message.send.daily",
      scope: "global_flag",
      version: 1,
      kind: "quota",
      enabled: false,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
    });
    const result = await service.consume({
      userId,
      key: "message.send.daily",
      operationId: "00000000-0000-4000-8000-000000000014",
      amount: 1,
      context: {},
    });
    expect(result).toMatchObject({ allowed: false, reason: "FEATURE_DISABLED" });
    expect(await database.select().from(schema.entitlementUsageCounters)).toEqual([]);
    expect(await database.select().from(schema.entitlementUsageOperations)).toHaveLength(1);
  });

  it("reads current safety status and verification policy inside the consume transaction", async () => {
    await database.insert(schema.profiles).values({ userId, status: "restricted" });
    await expect(service.consume({
      userId,
      key: "message.send.daily",
      operationId: "00000000-0000-4000-8000-000000000083",
      amount: 1,
      context: {},
    })).resolves.toMatchObject({ allowed: false, reason: "SAFETY_RESTRICTED" });

    await database.update(schema.profiles).set({ status: "active" })
      .where(eq(schema.profiles.userId, userId));
    const verificationRepository = new UsageRepository(database, {
      verificationResolver: async (transaction, ownerId, key, at) => {
        expect(transaction).toBeDefined();
        expect({ ownerId, key, at }).toEqual({ ownerId: userId, key: "message.send.daily", at: NOW });
        return false;
      },
    });
    const verificationService = new EntitlementService({
      store: verificationRepository,
      timeResolver: async () => NOW,
      policyResolver: (transaction, ownerId, key, now) =>
        verificationRepository.resolvePolicyInTransaction(transaction, ownerId, key, now),
      planResolver: async () => null,
    });
    await expect(verificationService.consume({
      userId,
      key: "message.send.daily",
      operationId: "00000000-0000-4000-8000-000000000084",
      amount: 1,
      context: {},
    })).resolves.toMatchObject({ allowed: false, reason: "VERIFICATION_REQUIRED" });
  });

  it("rejects non-primitive contexts and malformed runtime policy values", async () => {
    const base = {
      userId,
      key: "message.send.daily" as const,
      operationId: "00000000-0000-4000-8000-000000000015",
      amount: 1,
      context: {},
    };
    await expect(service.consume({
      ...base,
      context: { nested: {} } as never,
    })).rejects.toThrow("INVALID_ENTITLEMENT_CONTEXT");
  });

  it("can join a caller transaction and rolls usage back with the caller write", async () => {
    const input = {
      userId,
      key: "message.send.daily" as const,
      operationId: "00000000-0000-4000-8000-000000000016",
      amount: 1,
      context: { conversationId: "future-task-8" },
    };
    await expect(database.transaction(async (transaction) => {
      await service.consumeInTransaction(transaction, input);
      throw new Error("CALLER_ROLLBACK");
    })).rejects.toThrow("CALLER_ROLLBACK");
    expect(await database.select().from(schema.entitlementUsageCounters)).toEqual([]);
    expect(await database.select().from(schema.entitlementUsageOperations)).toEqual([]);
  });

  it("rejects database grants whose kind, value, hint, or numeric bounds are invalid", async () => {
    await expect(database.insert(schema.entitlementUserOverrides).values({
      userId,
      entitlementKey: "profile.incognito.use",
      kind: "quota",
      version: 1,
      quotaLimit: 1,
      effectiveAt: NOW,
    })).rejects.toThrow();
    await expect(database.insert(schema.entitlementPlanBenefits).values({
      planRef: "plus",
      entitlementKey: "profile.incognito.use",
      kind: "boolean",
      version: 1,
      booleanValue: true,
      upgradeHint: "Unsafe Plan Name",
      effectiveAt: NOW,
    })).rejects.toThrow();
    await expect(database.insert(schema.entitlementPlanBenefits).values({
      planRef: "plus",
      entitlementKey: "ranking.boost.multiplier",
      kind: "numeric",
      version: 1,
      numericValue: Number.POSITIVE_INFINITY,
      effectiveAt: NOW,
    })).rejects.toThrow();
    await expect(database.insert(schema.entitlementUserOverrides).values({
      userId,
      entitlementKey: "message.send.daily",
      kind: "quota",
      version: 2,
      quotaLimit: 1_000_001,
      effectiveAt: NOW,
    })).rejects.toThrow();
    await expect(database.insert(schema.entitlementPlanBenefits).values({
      planRef: "Unsafe Plan Name",
      entitlementKey: "super_like.monthly",
      kind: "quota",
      version: 3,
      quotaLimit: 1,
      effectiveAt: NOW,
    })).rejects.toThrow();
  });

  it("resolves only active versioned user plan assignments", async () => {
    await database.insert(schema.entitlementUserPlanAssignments).values([{
      userId,
      planRef: "expired-plus",
      version: 1,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-08-08T00:00:00Z"),
    }, {
      userId,
      planRef: "active-plus",
      version: 2,
      effectiveAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-08-09T00:00:00Z"),
    }]);
    await expect(database.transaction((transaction) =>
      repository.resolveActivePlanInTransaction(transaction, userId, NOW)))
      .resolves.toBe("active-plus");
    await database.update(schema.entitlementUserPlanAssignments).set({ active: false })
      .where(eq(schema.entitlementUserPlanAssignments.planRef, "active-plus"));
    await expect(database.transaction((transaction) =>
      repository.resolveActivePlanInTransaction(transaction, userId, NOW)))
      .resolves.toBeNull();
  });

  it("uses code-unit context ordering for stable Unicode idempotency", async () => {
    const operationId = "00000000-0000-4000-8000-000000000082";
    const base = {
      userId,
      key: "message.send.daily" as const,
      operationId,
      amount: 1,
    };
    const first = await service.consume({ ...base, context: { "ä": 1, Z: 2 } });
    const replay = await service.consume({ ...base, context: { Z: 2, "ä": 1 } });
    expect(replay).toEqual(first);
  });

  it("does not list a known registry key when public_visible is false", async () => {
    await database.update(schema.entitlementDefinitions).set({ publicVisible: false })
      .where(eq(schema.entitlementDefinitions.key, "profile.visitors.view"));
    const visibilityService = new EntitlementService({
      store: repository,
      timeResolver: async () => NOW,
      policyResolver: (transaction, ownerId, key, now) =>
        repository.resolvePolicyInTransaction(transaction, ownerId, key, now),
      planResolver: async () => null,
    });
    expect((await visibilityService.listPublic(userId)).map((decision) => decision.key))
      .not.toContain("profile.visitors.view");
  });
});
