import {
  ENTITLEMENT_CATALOG,
  PUBLIC_ENTITLEMENT_KEYS,
  type EntitlementCache,
  type EntitlementDecision,
  type EntitlementGrant,
  type EntitlementKey,
  type EntitlementPolicy,
  type EntitlementReason,
  type EntitlementStore,
  type ResolvedEntitlementSources,
  type ResetPeriod,
} from "./types";

type Session = { user: { id: string } };
type SessionReader = (headers: Headers) => Promise<Session | null>;

export function decideEntitlement(input: {
  enabled: boolean;
  limit: number | null;
  used: number;
  resetAt: string | null;
}) {
  if (!input.enabled) {
    return { allowed: false, remaining: 0, resetAt: input.resetAt, reason: "DISABLED" as const };
  }
  if (input.limit === null) {
    return { allowed: true, remaining: null, resetAt: input.resetAt, reason: null };
  }
  const remaining = Math.max(input.limit - input.used, 0);
  return {
    allowed: remaining > 0,
    remaining,
    resetAt: input.resetAt,
    reason: remaining > 0 ? null : "LIMIT_REACHED" as const,
  };
}

export function periodBounds(period: ResetPeriod, at: Date) {
  if (period === "none") return { periodStart: null, resetAt: null };
  if (period === "daily") {
    const periodStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    return { periodStart, resetAt: new Date(periodStart.getTime() + 86_400_000) };
  }
  const periodStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  return {
    periodStart,
    resetAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

function deniedDecision(
  key: EntitlementKey,
  sources: ResolvedEntitlementSources,
  reason: EntitlementReason,
): EntitlementDecision {
  const grant = sources.userOverride ?? sources.planBenefit ?? sources.freeDefault;
  return {
    key,
    kind: grant?.kind ?? ENTITLEMENT_CATALOG[key].kind,
    allowed: false,
    value: null,
    limit: grant?.quotaLimit ?? null,
    remaining: 0,
    resetAt: null,
    reason,
    upgradeHint: grant?.upgradeHint ?? null,
  };
}

export function resolveEntitlement(input: {
  key: EntitlementKey;
  sources: ResolvedEntitlementSources;
  policy: EntitlementPolicy;
  now: Date;
}): EntitlementDecision {
  const { key, sources, policy, now } = input;
  if (!policy.safetyAllowed) return deniedDecision(key, sources, "SAFETY_RESTRICTED");
  if (!policy.verificationSatisfied) return deniedDecision(key, sources, "VERIFICATION_REQUIRED");
  if (!sources.globalEnabled) return deniedDecision(key, sources, "FEATURE_DISABLED");

  const grant: EntitlementGrant | null = sources.userOverride ?? sources.planBenefit ?? sources.freeDefault;
  if (!grant || !grant.enabled) return deniedDecision(key, sources, "NOT_INCLUDED");
  const { resetAt } = periodBounds(grant.resetPeriod, now);

  if (grant.kind === "boolean") {
    const allowed = grant.booleanValue === true;
    return {
      key, kind: "boolean", allowed, value: allowed, limit: null, remaining: null,
      resetAt: null, reason: allowed ? null : "NOT_INCLUDED", upgradeHint: grant.upgradeHint,
    };
  }
  if (grant.kind === "numeric") {
    const value = grant.numericValue ?? 0;
    return {
      key, kind: "numeric", allowed: true, value, limit: null, remaining: null,
      resetAt: null, reason: null, upgradeHint: grant.upgradeHint,
    };
  }

  const allowance = decideEntitlement({
    enabled: true,
    limit: grant.quotaLimit,
    used: sources.used,
    resetAt: resetAt?.toISOString() ?? null,
  });
  return {
    key,
    kind: "quota",
    allowed: allowance.allowed,
    value: null,
    limit: grant.quotaLimit,
    remaining: allowance.remaining,
    resetAt: allowance.resetAt,
    reason: grant.quotaLimit === 0 && sources.used === 0
      ? "NOT_INCLUDED"
      : allowance.reason === "LIMIT_REACHED" ? "LIMIT_REACHED" : null,
    upgradeHint: grant.upgradeHint,
  };
}

export class EntitlementService {
  private readonly store: EntitlementStore;
  private readonly cache?: EntitlementCache;
  private readonly clock: () => Date;
  private readonly policyResolver: (userId: string, key: EntitlementKey) => Promise<EntitlementPolicy>;
  private readonly planResolver: (userId: string) => Promise<string | null>;

  constructor(options: {
    store: EntitlementStore;
    cache?: EntitlementCache;
    clock?: () => Date;
    policyResolver?: (userId: string, key: EntitlementKey) => Promise<EntitlementPolicy>;
    planResolver?: (userId: string) => Promise<string | null>;
  }) {
    this.store = options.store;
    this.cache = options.cache;
    this.clock = options.clock ?? (() => new Date());
    this.policyResolver = options.policyResolver ?? (async () => ({
      safetyAllowed: true,
      verificationSatisfied: true,
    }));
    this.planResolver = options.planResolver ?? (async () => null);
  }

  async decide(input: {
    userId: string;
    key: EntitlementKey;
    policy: EntitlementPolicy;
    planRef?: string | null;
  }) {
    const now = this.clock();
    try { await this.cache?.get(input.userId, input.key); } catch { /* cache is advisory */ }
    const sources = await this.store.resolve({
      userId: input.userId,
      key: input.key,
      planRef: input.planRef ?? null,
      now,
    });
    const decision = resolveEntitlement({ key: input.key, sources, policy: input.policy, now });
    try { await this.cache?.set(input.userId, input.key, decision); } catch { /* PostgreSQL won */ }
    return decision;
  }

  async listPublic(userId: string) {
    const planRef = await this.planResolver(userId);
    return Promise.all(PUBLIC_ENTITLEMENT_KEYS.map((key) => this.decideForUser(userId, key, planRef)));
  }

  async decideForUser(userId: string, key: EntitlementKey, knownPlanRef?: string | null) {
    const planRef = knownPlanRef === undefined ? await this.planResolver(userId) : knownPlanRef;
    return this.decide({
      userId,
      key,
      planRef,
      policy: await this.policyResolver(userId, key),
    });
  }

  async consume(input: {
    userId: string;
    key: EntitlementKey;
    operationId: string;
    amount?: number;
    context?: Readonly<Record<string, string | number | boolean | null>>;
    policy: EntitlementPolicy;
    planRef?: string | null;
  }) {
    return this.store.consume({
      userId: input.userId,
      key: input.key,
      operationId: input.operationId,
      amount: input.amount ?? 1,
      context: input.context ?? {},
      policy: input.policy,
      planRef: input.planRef ?? null,
      now: this.clock(),
    });
  }
}

const publicKeys = new Set<string>(PUBLIC_ENTITLEMENT_KEYS);
const publicKinds = new Set(["boolean", "quota", "numeric"]);
const publicReasons = new Set([
  "SAFETY_RESTRICTED", "VERIFICATION_REQUIRED", "FEATURE_DISABLED", "NOT_INCLUDED", "LIMIT_REACHED",
]);
const publicUpgradePattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const safeDecision = (row: Record<string, unknown>) => {
  if (!publicKeys.has(String(row.key))
    || !publicKinds.has(String(row.kind))
    || typeof row.allowed !== "boolean"
    || (row.reason !== null && row.reason !== undefined && !publicReasons.has(String(row.reason)))
    || (row.upgradeHint !== null && row.upgradeHint !== undefined
      && !publicUpgradePattern.test(String(row.upgradeHint)))) return null;
  return {
    key: row.key,
    kind: row.kind,
    allowed: row.allowed,
    value: row.value ?? null,
    limit: row.limit ?? null,
    remaining: row.remaining ?? null,
    resetAt: row.resetAt ?? null,
    reason: row.reason ?? null,
    upgradeHint: row.upgradeHint ?? null,
  };
};

export function createEntitlementsHandler(input: {
  getSession: SessionReader;
  service: Pick<EntitlementService, "listPublic">;
}) {
  return async (request: Request) => {
    let session: Session | null;
    try { session = await input.getSession(request.headers); } catch {
      return Response.json({ code: "INTERNAL_ERROR", message: "INTERNAL_ERROR" }, { status: 500 });
    }
    if (!session) {
      return Response.json({ code: "UNAUTHORIZED", message: "UNAUTHORIZED" }, { status: 401 });
    }
    try {
      const rows = await input.service.listPublic(session.user.id);
      return Response.json({
        entitlements: rows.flatMap((row) => {
          const safe = safeDecision(row as unknown as Record<string, unknown>);
          return safe ? [safe] : [];
        }),
      });
    } catch {
      return Response.json({ code: "INTERNAL_ERROR", message: "INTERNAL_ERROR" }, { status: 500 });
    }
  };
}
