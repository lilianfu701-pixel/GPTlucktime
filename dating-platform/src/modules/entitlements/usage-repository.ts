import { createHash } from "node:crypto";

import {
  and,
  desc,
  eq,
  gt,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  entitlementConfigurations,
  entitlementDefinitions,
  entitlementPlanBenefits,
  entitlementUserPlanAssignments,
  entitlementUsageCounters,
  entitlementUsageOperations,
  entitlementUserOverrides,
  profiles,
  users,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import { parseEntitlementGrant, periodBounds, resolveEntitlement } from "./entitlement-service";
import {
  ENTITLEMENT_CATALOG,
  MAX_ENTITLEMENT_QUOTA,
  type AuthoritativeConsumeInput,
  type EntitlementDecision,
  type EntitlementGrant,
  type EntitlementKey,
  type EntitlementPolicy,
  type EntitlementTransaction,
  type ResolvedConsumeEntitlementInput,
  type ResolvedEntitlementSources,
  type ResolveEntitlementInput,
  type ResetPeriod,
} from "./types";

type EntitlementDatabase = typeof productionDatabase;
type GrantRow = {
  kind: string;
  enabled: boolean;
  booleanValue: boolean | null;
  quotaLimit: number | null;
  numericValue: number | null;
  upgradeHint: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CONTEXT_KEY_PATTERN = /^[\p{L}_][\p{L}\p{N}_.-]{0,63}$/u;

function canonicalContext(context: AuthoritativeConsumeInput["context"]) {
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("INVALID_ENTITLEMENT_CONTEXT");
  }
  const entries = Object.entries(context);
  if (entries.length > 20) throw new Error("INVALID_ENTITLEMENT_CONTEXT");
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [key, value] of entries) {
    if (!CONTEXT_KEY_PATTERN.test(key)) throw new Error("INVALID_ENTITLEMENT_CONTEXT");
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error("INVALID_ENTITLEMENT_CONTEXT");
    }
    if (typeof value === "string" && value.length > 256) throw new Error("INVALID_ENTITLEMENT_CONTEXT");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("INVALID_ENTITLEMENT_CONTEXT");
  }
  return JSON.stringify(Object.fromEntries(entries));
}

function contextHash(context: AuthoritativeConsumeInput["context"]) {
  return createHash("sha256").update(canonicalContext(context)).digest("hex");
}

function asGrant(
  row: GrantRow | undefined,
  expectedKind: EntitlementGrant["kind"],
  resetPeriod: ResetPeriod,
): EntitlementGrant | null {
  if (!row) return null;
  return parseEntitlementGrant(row, expectedKind, resetPeriod);
}

function operationToDecision(row: typeof entitlementUsageOperations.$inferSelect): EntitlementDecision {
  const value = row.kind === "boolean"
    ? row.value === 1
    : row.value;
  return {
    key: row.entitlementKey as EntitlementKey,
    kind: row.kind as EntitlementDecision["kind"],
    allowed: row.allowed,
    value,
    limit: row.limit,
    remaining: row.remaining,
    resetAt: row.resetAt?.toISOString() ?? null,
    reason: row.reason as EntitlementDecision["reason"],
    upgradeHint: row.upgradeHint,
  };
}

function operationMatches(
  row: typeof entitlementUsageOperations.$inferSelect,
  input: ResolvedConsumeEntitlementInput,
  hash: string,
) {
  return row.userId === input.userId
    && row.entitlementKey === input.key
    && row.contextHash === hash
    && row.amount === input.amount;
}

export class UsageRepository {
  private readonly database: EntitlementDatabase;
  private readonly verificationResolver: (
    transaction: EntitlementTransaction,
    userId: string,
    key: EntitlementKey,
    now: Date,
  ) => Promise<boolean>;

  constructor(database: unknown, options: {
    verificationResolver?: (
      transaction: EntitlementTransaction,
      userId: string,
      key: EntitlementKey,
      now: Date,
    ) => Promise<boolean>;
  } = {}) {
    this.database = database as EntitlementDatabase;
    this.verificationResolver = options.verificationResolver ?? (async () => true);
  }

  transaction<T>(work: (transaction: EntitlementTransaction) => Promise<T>) {
    return this.database.transaction((transaction) => work(transaction));
  }

  async resolve(input: ResolveEntitlementInput): Promise<ResolvedEntitlementSources> {
    this.validateResolveInput(input);
    return this.resolveInDatabase(this.database, input);
  }

  async resolveInTransaction(transaction: EntitlementTransaction, input: ResolveEntitlementInput) {
    this.validateResolveInput(input);
    return this.resolveInDatabase(transaction as EntitlementDatabase, input);
  }

  async resolvePolicyInTransaction(
    transaction: EntitlementTransaction,
    userId: string,
    key: EntitlementKey,
    now: Date,
  ): Promise<EntitlementPolicy> {
    if (!UUID_PATTERN.test(userId)) throw new Error("INVALID_USER_ID");
    const database = transaction as EntitlementDatabase;
    const [profile] = await database.select({ status: profiles.status })
      .from(profiles).where(eq(profiles.userId, userId)).limit(1);
    return {
      safetyAllowed: !profile || !["restricted", "suspended", "banned"].includes(profile.status),
      verificationSatisfied: await this.verificationResolver(transaction, userId, key, now),
    };
  }

  async resolvePolicy(userId: string, key: EntitlementKey = "message.send.daily") {
    return this.transaction(async (transaction) => this.resolvePolicyInTransaction(
      transaction, userId, key, await this.authoritativeNow(transaction),
    ));
  }

  async authoritativeNow(transaction: EntitlementTransaction) {
    const result = await (transaction as EntitlementDatabase).execute(sql`SELECT CURRENT_TIMESTAMP AS "now"`);
    const rows = (result as unknown as { rows?: Array<{ now: Date | string }> }).rows
      ?? result as unknown as Array<{ now: Date | string }>;
    const value = rows[0]?.now;
    const now = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(now.getTime())) throw new Error("AUTHORITATIVE_TIME_UNAVAILABLE");
    return now;
  }

  async resolveActivePlanInTransaction(transaction: EntitlementTransaction, userId: string, now: Date) {
    if (!UUID_PATTERN.test(userId) || Number.isNaN(now.getTime())) throw new Error("INVALID_PLAN_ASSIGNMENT_LOOKUP");
    const [assignment] = await (transaction as EntitlementDatabase).select({
      planRef: entitlementUserPlanAssignments.planRef,
    }).from(entitlementUserPlanAssignments).where(and(
      eq(entitlementUserPlanAssignments.userId, userId),
      eq(entitlementUserPlanAssignments.active, true),
      lte(entitlementUserPlanAssignments.effectiveAt, now),
      or(isNull(entitlementUserPlanAssignments.expiresAt), gt(entitlementUserPlanAssignments.expiresAt, now)),
    )).orderBy(
      desc(entitlementUserPlanAssignments.version),
      desc(entitlementUserPlanAssignments.effectiveAt),
    ).limit(1);
    return assignment?.planRef ?? null;
  }

  /** @internal Called only by EntitlementService after server authority resolution. */
  async consumeResolvedInTransaction(
    transaction: EntitlementTransaction,
    input: ResolvedConsumeEntitlementInput,
  ) {
    this.validateConsumeInput(input);
    return this.consumeLocked(
      transaction as EntitlementDatabase,
      input,
      contextHash(input.context),
    );
  }

  private async consumeLocked(
    tx: EntitlementDatabase,
    input: ResolvedConsumeEntitlementInput,
    hash: string,
  ): Promise<EntitlementDecision> {
    const replay = await this.findOperation(tx, input.operationId);
    if (replay) {
      if (!operationMatches(replay, input, hash)) throw new Error("OPERATION_ID_CONFLICT");
      return operationToDecision(replay);
    }

    const [owner] = await tx.select({ id: users.id }).from(users)
      .where(eq(users.id, input.userId)).for("update").limit(1);
    if (!owner) throw new Error("ENTITLEMENT_OWNER_NOT_FOUND");

    const sources = await this.resolveInDatabase(tx, input);
    let decision = resolveEntitlement({
      key: input.key,
      sources,
      policy: input.policy,
      now: input.now,
    });

    if (decision.kind === "quota" && decision.allowed && decision.limit !== null) {
      const { periodStart, resetAt } = periodBounds(
        ENTITLEMENT_CATALOG[input.key].resetPeriod,
        input.now,
      );
      if (!periodStart || !resetAt) throw new Error("INVALID_ENTITLEMENT_PERIOD");
      await tx.insert(entitlementUsageCounters).values({
        userId: input.userId,
        entitlementKey: input.key,
        periodStart,
        resetAt,
        used: 0,
        updatedAt: input.now,
      }).onConflictDoNothing();
      const [updated] = await tx.update(entitlementUsageCounters).set({
        used: sql`${entitlementUsageCounters.used} + ${input.amount}`,
        version: sql`${entitlementUsageCounters.version} + 1`,
        updatedAt: input.now,
      }).where(and(
        eq(entitlementUsageCounters.userId, input.userId),
        eq(entitlementUsageCounters.entitlementKey, input.key),
        eq(entitlementUsageCounters.periodStart, periodStart),
        lte(
          entitlementUsageCounters.used,
          sql`${decision.limit}::integer - ${input.amount}::integer`,
        ),
      )).returning({ used: entitlementUsageCounters.used });
      if (updated) {
        decision = { ...decision, remaining: Math.max(decision.limit - updated.used, 0) };
      } else {
        const [current] = await tx.select({ used: entitlementUsageCounters.used })
          .from(entitlementUsageCounters).where(and(
            eq(entitlementUsageCounters.userId, input.userId),
            eq(entitlementUsageCounters.entitlementKey, input.key),
            eq(entitlementUsageCounters.periodStart, periodStart),
          )).limit(1);
        decision = {
          ...decision,
          allowed: false,
          remaining: Math.max(decision.limit - (current?.used ?? 0), 0),
          reason: "LIMIT_REACHED",
        };
      }
    }

    try {
      await tx.insert(entitlementUsageOperations).values({
        operationId: input.operationId,
        userId: input.userId,
        entitlementKey: input.key,
        contextHash: hash,
        amount: input.amount,
        kind: decision.kind,
        allowed: decision.allowed,
        value: typeof decision.value === "boolean" ? (decision.value ? 1 : 0) : decision.value,
        limit: decision.limit,
        remaining: decision.remaining,
        resetAt: decision.resetAt ? new Date(decision.resetAt) : null,
        reason: decision.reason,
        upgradeHint: decision.upgradeHint,
        createdAt: input.now,
      });
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } }).code
        ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") throw new Error("OPERATION_ID_CONFLICT");
      throw error;
    }
    return decision;
  }

  private async resolveInDatabase(database: EntitlementDatabase, input: ResolveEntitlementInput) {
    const [definition] = await database.select().from(entitlementDefinitions)
      .where(eq(entitlementDefinitions.key, input.key)).limit(1);
    if (!definition) throw new Error("UNKNOWN_ENTITLEMENT");
    const catalog = ENTITLEMENT_CATALOG[input.key];
    const resetPeriod = definition.resetPeriod as ResetPeriod;
    let configurationInvalid = definition.kind !== catalog.kind || resetPeriod !== catalog.resetPeriod;
    const activeAt = and(
      eq(entitlementConfigurations.entitlementKey, input.key),
      eq(entitlementConfigurations.active, true),
      lte(entitlementConfigurations.effectiveAt, input.now),
      or(isNull(entitlementConfigurations.expiresAt), gt(entitlementConfigurations.expiresAt, input.now)),
    );
    const [global] = await database.select({
      kind: entitlementConfigurations.kind,
      enabled: entitlementConfigurations.enabled,
      booleanValue: entitlementConfigurations.booleanValue,
      quotaLimit: entitlementConfigurations.quotaLimit,
      numericValue: entitlementConfigurations.numericValue,
      upgradeHint: entitlementConfigurations.upgradeHint,
    })
      .from(entitlementConfigurations).where(and(
        activeAt,
        eq(entitlementConfigurations.scope, "global_flag"),
      )).orderBy(desc(entitlementConfigurations.version), desc(entitlementConfigurations.effectiveAt)).limit(1);
    const [freeDefault] = await database.select({
      kind: entitlementConfigurations.kind,
      enabled: entitlementConfigurations.enabled,
      booleanValue: entitlementConfigurations.booleanValue,
      quotaLimit: entitlementConfigurations.quotaLimit,
      numericValue: entitlementConfigurations.numericValue,
      upgradeHint: entitlementConfigurations.upgradeHint,
    }).from(entitlementConfigurations).where(and(
      activeAt,
      eq(entitlementConfigurations.scope, "free_default"),
    )).orderBy(desc(entitlementConfigurations.version), desc(entitlementConfigurations.effectiveAt)).limit(1);

    const [userOverride] = await database.select({
      kind: entitlementUserOverrides.kind,
      enabled: entitlementUserOverrides.enabled,
      booleanValue: entitlementUserOverrides.booleanValue,
      quotaLimit: entitlementUserOverrides.quotaLimit,
      numericValue: entitlementUserOverrides.numericValue,
      upgradeHint: entitlementUserOverrides.upgradeHint,
    }).from(entitlementUserOverrides).where(and(
      eq(entitlementUserOverrides.userId, input.userId),
      eq(entitlementUserOverrides.entitlementKey, input.key),
      eq(entitlementUserOverrides.active, true),
      lte(entitlementUserOverrides.effectiveAt, input.now),
      or(isNull(entitlementUserOverrides.expiresAt), gt(entitlementUserOverrides.expiresAt, input.now)),
    )).orderBy(desc(entitlementUserOverrides.version), desc(entitlementUserOverrides.effectiveAt)).limit(1);

    const planRef = input.planRef && PUBLIC_REF_PATTERN.test(input.planRef) ? input.planRef : null;
    const [planBenefit] = planRef ? await database.select({
      kind: entitlementPlanBenefits.kind,
      enabled: entitlementPlanBenefits.enabled,
      booleanValue: entitlementPlanBenefits.booleanValue,
      quotaLimit: entitlementPlanBenefits.quotaLimit,
      numericValue: entitlementPlanBenefits.numericValue,
      upgradeHint: entitlementPlanBenefits.upgradeHint,
    }).from(entitlementPlanBenefits).where(and(
      eq(entitlementPlanBenefits.planRef, planRef),
      eq(entitlementPlanBenefits.entitlementKey, input.key),
      eq(entitlementPlanBenefits.active, true),
      lte(entitlementPlanBenefits.effectiveAt, input.now),
      or(isNull(entitlementPlanBenefits.expiresAt), gt(entitlementPlanBenefits.expiresAt, input.now)),
    )).orderBy(desc(entitlementPlanBenefits.version), desc(entitlementPlanBenefits.effectiveAt)).limit(1) : [];

    let used = 0;
    const { periodStart } = periodBounds(resetPeriod, input.now);
    if (periodStart) {
      const [counter] = await database.select({ used: entitlementUsageCounters.used })
        .from(entitlementUsageCounters).where(and(
          eq(entitlementUsageCounters.userId, input.userId),
          eq(entitlementUsageCounters.entitlementKey, input.key),
          eq(entitlementUsageCounters.periodStart, periodStart),
        )).limit(1);
      used = counter?.used ?? 0;
    }
    const globalInvalid = Boolean(global && (global.kind !== catalog.kind || global.booleanValue !== null
      || global.quotaLimit !== null || global.numericValue !== null || global.upgradeHint !== null));
    if (globalInvalid) configurationInvalid = true;
    const parse = (row: GrantRow | undefined) => {
      try { return asGrant(row, catalog.kind, catalog.resetPeriod); } catch {
        configurationInvalid = true;
        return null;
      }
    };
    const parsedOverride = parse(userOverride);
    const parsedPlan = parse(planBenefit);
    const parsedDefault = parse(freeDefault);
    return {
      globalEnabled: globalInvalid ? true : global?.enabled ?? true,
      configurationInvalid,
      publicVisible: definition.publicVisible && !configurationInvalid,
      userOverride: parsedOverride,
      planBenefit: parsedPlan,
      freeDefault: parsedDefault,
      used,
    } satisfies ResolvedEntitlementSources;
  }

  private findOperation(database: EntitlementDatabase, operationId: string) {
    return database.select().from(entitlementUsageOperations)
      .where(eq(entitlementUsageOperations.operationId, operationId)).limit(1)
      .then((rows) => rows[0]);
  }

  private validateResolveInput(input: ResolveEntitlementInput) {
    if (!UUID_PATTERN.test(input.userId)) throw new Error("INVALID_USER_ID");
    if (!Object.hasOwn(ENTITLEMENT_CATALOG, input.key)) throw new Error("UNKNOWN_ENTITLEMENT");
    if (Number.isNaN(input.now.getTime())) throw new Error("INVALID_ENTITLEMENT_TIME");
    if (input.planRef !== null && input.planRef !== undefined && !PUBLIC_REF_PATTERN.test(input.planRef)) {
      throw new Error("INVALID_PLAN_REF");
    }
  }

  private validateConsumeInput(input: ResolvedConsumeEntitlementInput) {
    this.validateResolveInput(input);
    if (!UUID_PATTERN.test(input.operationId)) throw new Error("INVALID_OPERATION_ID");
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_ENTITLEMENT_QUOTA) {
      throw new Error("INVALID_ENTITLEMENT_AMOUNT");
    }
    if (typeof input.policy?.safetyAllowed !== "boolean"
      || typeof input.policy?.verificationSatisfied !== "boolean") {
      throw new Error("INVALID_ENTITLEMENT_POLICY");
    }
    canonicalContext(input.context);
  }
}
