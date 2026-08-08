import {
  ENTITLEMENT_CATALOG,
  ENTITLEMENT_NUMERIC_SCALE,
  MAX_ENTITLEMENT_NUMERIC,
  MAX_ENTITLEMENT_QUOTA,
  PUBLIC_ENTITLEMENT_KEYS,
  type AuthoritativeConsumeInput,
  type EntitlementCache,
  type EntitlementDecision,
  type EntitlementGrant,
  type EntitlementKey,
  type EntitlementPolicy,
  type EntitlementPolicyResolver,
  type EntitlementPlanResolver,
  type EntitlementReason,
  type EntitlementStore,
  type EntitlementTimeResolver,
  type EntitlementTransaction,
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

const publicUpgradePattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const hasSupportedScale = (value: number) => {
  const factor = 10 ** ENTITLEMENT_NUMERIC_SCALE;
  const scaled = value * factor;
  return Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
};

export function parseEntitlementGrant(
  row: {
    kind: unknown;
    enabled: unknown;
    booleanValue: unknown;
    quotaLimit: unknown;
    numericValue: unknown;
    upgradeHint: unknown;
  },
  expectedKind: EntitlementGrant["kind"],
  resetPeriod: ResetPeriod,
): EntitlementGrant {
  if (row.kind !== expectedKind || typeof row.enabled !== "boolean"
    || (row.upgradeHint !== null && (typeof row.upgradeHint !== "string"
      || !publicUpgradePattern.test(row.upgradeHint)))) throw new Error("CONFIGURATION_INVALID");
  if (expectedKind === "boolean") {
    if (typeof row.booleanValue !== "boolean" || row.quotaLimit !== null || row.numericValue !== null
      || resetPeriod !== "none") throw new Error("CONFIGURATION_INVALID");
  } else if (expectedKind === "quota") {
    if (row.booleanValue !== null || row.numericValue !== null
      || (row.quotaLimit !== null && (typeof row.quotaLimit !== "number"
        || !Number.isInteger(row.quotaLimit) || row.quotaLimit < 0
        || row.quotaLimit > MAX_ENTITLEMENT_QUOTA))
      || resetPeriod === "none") throw new Error("CONFIGURATION_INVALID");
  } else if (row.booleanValue !== null || row.quotaLimit !== null
    || typeof row.numericValue !== "number" || !Number.isFinite(row.numericValue)
    || row.numericValue < 0 || row.numericValue > MAX_ENTITLEMENT_NUMERIC
    || !hasSupportedScale(row.numericValue) || resetPeriod !== "none") {
    throw new Error("CONFIGURATION_INVALID");
  }
  return {
    kind: expectedKind,
    enabled: row.enabled,
    booleanValue: row.booleanValue as boolean | null,
    quotaLimit: row.quotaLimit as number | null,
    numericValue: row.numericValue as number | null,
    resetPeriod,
    upgradeHint: row.upgradeHint as string | null,
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
  if (sources.configurationInvalid) return deniedDecision(key, sources, "CONFIGURATION_INVALID");

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
  private readonly timeResolver: EntitlementTimeResolver;
  private readonly policyResolver: EntitlementPolicyResolver;
  private readonly planResolver: EntitlementPlanResolver;
  private readonly inFlightOperations = new Map<string, {
    signature: string;
    promise: Promise<EntitlementDecision>;
  }>();

  constructor(options: {
    store: EntitlementStore;
    cache?: EntitlementCache;
    timeResolver: EntitlementTimeResolver;
    policyResolver: EntitlementPolicyResolver;
    planResolver: EntitlementPlanResolver;
  }) {
    this.store = options.store;
    this.cache = options.cache;
    this.timeResolver = options.timeResolver;
    this.policyResolver = options.policyResolver;
    this.planResolver = options.planResolver;
  }

  private async decideInTransaction(
    transaction: EntitlementTransaction,
    userId: string,
    key: EntitlementKey,
    now: Date,
    planRef: string | null,
  ) {
    try { await this.cache?.get(userId, key); } catch { /* cache is advisory */ }
    const policy = await this.policyResolver(transaction, userId, key, now);
    const sources = await this.store.resolveInTransaction(transaction, { userId, key, planRef, now });
    const decision = resolveEntitlement({ key, sources, policy, now });
    try { await this.cache?.set(userId, key, decision); } catch { /* PostgreSQL won */ }
    return { decision, publicVisible: sources.publicVisible === true };
  }

  async listPublic(userId: string) {
    return this.store.transaction(async (transaction) => {
      const now = await this.timeResolver(transaction);
      const planRef = await this.planResolver(transaction, userId, now);
      const rows = [] as EntitlementDecision[];
      for (const key of PUBLIC_ENTITLEMENT_KEYS) {
        const resolved = await this.decideInTransaction(transaction, userId, key, now, planRef);
        if (resolved.publicVisible) rows.push(resolved.decision);
      }
      return rows;
    });
  }

  async decideForUser(userId: string, key: EntitlementKey) {
    return this.store.transaction(async (transaction) => {
      const now = await this.timeResolver(transaction);
      const planRef = await this.planResolver(transaction, userId, now);
      return (await this.decideInTransaction(transaction, userId, key, now, planRef)).decision;
    });
  }

  async consume(input: AuthoritativeConsumeInput) {
    const signature = JSON.stringify({
      userId: input.userId,
      key: input.key,
      amount: input.amount,
      context: Object.fromEntries(Object.entries(input.context)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    });
    const existing = this.inFlightOperations.get(input.operationId);
    if (existing) {
      if (existing.signature !== signature) throw new Error("OPERATION_ID_CONFLICT");
      return existing.promise;
    }
    const transactionPromise = this.store.transaction((transaction) =>
      this.consumeInTransaction(transaction, input));
    const promise = transactionPromise.finally(() => {
      if (this.inFlightOperations.get(input.operationId)?.promise === promise) {
        this.inFlightOperations.delete(input.operationId);
      }
    });
    this.inFlightOperations.set(input.operationId, { signature, promise });
    return promise;
  }

  async consumeInTransaction(transaction: EntitlementTransaction, input: AuthoritativeConsumeInput) {
    const now = await this.timeResolver(transaction);
    const policy = await this.policyResolver(transaction, input.userId, input.key, now);
    const planRef = await this.planResolver(transaction, input.userId, now);
    return this.store.consumeResolvedInTransaction(transaction, {
      userId: input.userId,
      key: input.key,
      operationId: input.operationId,
      amount: input.amount,
      context: input.context,
      policy,
      planRef,
      now,
    });
  }
}

const publicKeys = new Set<string>(PUBLIC_ENTITLEMENT_KEYS);
const publicKinds = new Set(["boolean", "quota", "numeric"]);
const publicReasons = new Set([
  "SAFETY_RESTRICTED", "VERIFICATION_REQUIRED", "FEATURE_DISABLED", "NOT_INCLUDED", "LIMIT_REACHED",
  "CONFIGURATION_INVALID",
]);
const safeDecision = (row: Record<string, unknown>) => {
  if (typeof row.key !== "string" || !publicKeys.has(row.key)
    || typeof row.kind !== "string" || !publicKinds.has(row.kind)
    || row.kind !== ENTITLEMENT_CATALOG[row.key as EntitlementKey].kind
    || typeof row.allowed !== "boolean"
    || (row.reason !== null && row.reason !== undefined
      && (typeof row.reason !== "string" || !publicReasons.has(row.reason)))
    || (row.upgradeHint !== null && row.upgradeHint !== undefined
      && (typeof row.upgradeHint !== "string" || !publicUpgradePattern.test(row.upgradeHint)))
    || (row.resetAt !== null && row.resetAt !== undefined
      && (typeof row.resetAt !== "string" || Number.isNaN(Date.parse(row.resetAt))))
    || (row.value !== null && row.value !== undefined
      && (typeof row.value !== "boolean" && (typeof row.value !== "number" || !Number.isFinite(row.value))))
    || (row.limit !== null && row.limit !== undefined
      && (typeof row.limit !== "number" || !Number.isInteger(row.limit) || row.limit < 0
        || row.limit > MAX_ENTITLEMENT_QUOTA))
    || (row.remaining !== null && row.remaining !== undefined
      && (typeof row.remaining !== "number" || !Number.isInteger(row.remaining) || row.remaining < 0
        || row.remaining > MAX_ENTITLEMENT_QUOTA))) return null;
  if (row.kind === "boolean" && ((row.value !== null && row.value !== undefined
    && typeof row.value !== "boolean") || row.limit != null || row.remaining != null || row.resetAt != null)) return null;
  if (row.kind === "numeric" && ((row.value !== null && row.value !== undefined
    && (typeof row.value !== "number" || row.value < 0 || row.value > MAX_ENTITLEMENT_NUMERIC
      || !hasSupportedScale(row.value))) || row.limit != null || row.remaining != null || row.resetAt != null)) return null;
  if (row.kind === "quota" && (row.value != null
    || (row.limit !== null && row.limit !== undefined && row.remaining !== null
      && row.remaining !== undefined && row.remaining > row.limit))) return null;
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
