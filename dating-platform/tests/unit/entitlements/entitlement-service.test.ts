// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  decideEntitlement,
  EntitlementService,
  parseEntitlementGrant,
  resolveEntitlement,
} from "@/modules/entitlements/entitlement-service";
import type {
  EntitlementCache,
  EntitlementStore,
  ResolvedEntitlementSources,
} from "@/modules/entitlements/types";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-08T12:00:00Z");

const freeMessage: ResolvedEntitlementSources = {
  globalEnabled: true,
  userOverride: null,
  planBenefit: null,
  freeDefault: {
    kind: "quota",
    enabled: true,
    quotaLimit: null,
    booleanValue: null,
    numericValue: null,
    resetPeriod: "daily",
    upgradeHint: null,
  },
  used: 0,
};

describe("decideEntitlement", () => {
  it("reports the remaining daily allowance", () => {
    expect(decideEntitlement({
      enabled: true,
      limit: 5,
      used: 2,
      resetAt: "2026-08-09T00:00:00.000Z",
    })).toEqual({
      allowed: true,
      remaining: 3,
      resetAt: "2026-08-09T00:00:00.000Z",
      reason: null,
    });
  });

  it("denies disabled and exhausted allowances with stable public reasons", () => {
    expect(decideEntitlement({ enabled: false, limit: null, used: 0, resetAt: null }))
      .toEqual({ allowed: false, remaining: 0, resetAt: null, reason: "DISABLED" });
    expect(decideEntitlement({ enabled: true, limit: 2, used: 2, resetAt: null }))
      .toEqual({ allowed: false, remaining: 0, resetAt: null, reason: "LIMIT_REACHED" });
  });
});

describe("resolveEntitlement", () => {
  it("applies safety and verification before global, override, plan, and free rules", () => {
    const sources: ResolvedEntitlementSources = {
      ...freeMessage,
      userOverride: { ...freeMessage.freeDefault!, quotaLimit: 20 },
      planBenefit: { ...freeMessage.freeDefault!, quotaLimit: 10 },
    };

    expect(resolveEntitlement({
      key: "message.send.daily",
      sources,
      policy: { safetyAllowed: false, verificationSatisfied: true },
      now: NOW,
    }).reason).toBe("SAFETY_RESTRICTED");
    expect(resolveEntitlement({
      key: "message.send.daily",
      sources,
      policy: { safetyAllowed: true, verificationSatisfied: false },
      now: NOW,
    }).reason).toBe("VERIFICATION_REQUIRED");
    expect(resolveEntitlement({
      key: "message.send.daily",
      sources: { ...sources, globalEnabled: false },
      policy: { safetyAllowed: true, verificationSatisfied: true },
      now: NOW,
    }).reason).toBe("FEATURE_DISABLED");
    expect(resolveEntitlement({
      key: "message.send.daily",
      sources,
      policy: { safetyAllowed: true, verificationSatisfied: true },
      now: NOW,
    }).limit).toBe(20);
  });

  it("uses plan before free default and supports boolean, quota, and numeric outputs", () => {
    const planSources: ResolvedEntitlementSources = {
      ...freeMessage,
      planBenefit: { ...freeMessage.freeDefault!, quotaLimit: 9 },
      used: 3,
    };
    const quota = resolveEntitlement({
      key: "message.send.daily",
      sources: planSources,
      policy: { safetyAllowed: true, verificationSatisfied: true },
      now: NOW,
    });
    expect(quota).toMatchObject({ kind: "quota", allowed: true, limit: 9, remaining: 6 });

    const bool = resolveEntitlement({
      key: "profile.incognito.use",
      sources: {
        globalEnabled: true, userOverride: null, planBenefit: null, used: 0,
        freeDefault: {
          kind: "boolean", enabled: true, booleanValue: true, quotaLimit: null,
          numericValue: null, resetPeriod: "none", upgradeHint: null,
        },
      },
      policy: { safetyAllowed: true, verificationSatisfied: true },
      now: NOW,
    });
    expect(bool).toMatchObject({ kind: "boolean", allowed: true, value: true, remaining: null });

    const numeric = resolveEntitlement({
      key: "ranking.boost.multiplier",
      sources: {
        globalEnabled: true, userOverride: null, planBenefit: null, used: 0,
        freeDefault: {
          kind: "numeric", enabled: true, booleanValue: null, quotaLimit: null,
          numericValue: 1, resetPeriod: "none", upgradeHint: null,
        },
      },
      policy: { safetyAllowed: true, verificationSatisfied: true },
      now: NOW,
    });
    expect(numeric).toMatchObject({ kind: "numeric", allowed: true, value: 1, remaining: null });
  });

  it("fails closed instead of falling through an invalid higher-priority grant", () => {
    const decision = resolveEntitlement({
      key: "profile.incognito.use",
      sources: {
        globalEnabled: true,
        configurationInvalid: true,
        userOverride: null,
        planBenefit: null,
        freeDefault: {
          kind: "boolean", enabled: true, booleanValue: true, quotaLimit: null,
          numericValue: null, resetPeriod: "none", upgradeHint: null,
        },
        used: 0,
      },
      policy: { safetyAllowed: true, verificationSatisfied: true },
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, reason: "CONFIGURATION_INVALID" });
  });

  it("rejects wrong kinds, invalid shapes, unsafe hints, and non-finite numeric grants", () => {
    const base = {
      enabled: true,
      booleanValue: null,
      quotaLimit: null,
      numericValue: null,
      upgradeHint: null,
    };
    expect(() => parseEntitlementGrant({ ...base, kind: "quota", quotaLimit: 1 }, "boolean", "none"))
      .toThrow("CONFIGURATION_INVALID");
    expect(() => parseEntitlementGrant({ ...base, kind: "boolean", booleanValue: null }, "boolean", "none"))
      .toThrow("CONFIGURATION_INVALID");
    expect(() => parseEntitlementGrant({
      ...base, kind: "boolean", booleanValue: true, upgradeHint: "Internal Plan Name",
    }, "boolean", "none")).toThrow("CONFIGURATION_INVALID");
    for (const numericValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.00001]) {
      expect(() => parseEntitlementGrant({ ...base, kind: "numeric", numericValue }, "numeric", "none"))
        .toThrow("CONFIGURATION_INVALID");
    }
  });
});

describe("EntitlementService", () => {
  it("stays PostgreSQL-authoritative on cache miss and cache outage", async () => {
    const resolveInTransaction = vi.fn().mockResolvedValue({ ...freeMessage, publicVisible: true });
    const store = {
      transaction: async <T>(work: (transaction: unknown) => Promise<T>) => work({}),
      resolveInTransaction,
    } as unknown as EntitlementStore;
    const missCache: EntitlementCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const outageCache: EntitlementCache = {
      get: vi.fn().mockRejectedValue(new Error("redis unavailable")),
      set: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };

    for (const cache of [missCache, outageCache]) {
      const service = new EntitlementService({
        store,
        cache,
        timeResolver: async () => NOW,
        policyResolver: async () => ({ safetyAllowed: true, verificationSatisfied: true }),
        planResolver: async () => null,
      });
      await expect(service.decideForUser(USER_ID, "message.send.daily"))
        .resolves.toMatchObject({ allowed: true, remaining: null });
    }
    expect(resolveInTransaction).toHaveBeenCalledTimes(2);
  });
});
