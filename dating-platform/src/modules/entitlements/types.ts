// This is the audited public API v1 registry. Operators may version and change
// these known keys in PostgreSQL; an unknown database key is never reflected to
// clients until a code/API review explicitly adds it here.
export const PUBLIC_ENTITLEMENT_KEYS = [
  "message.send.daily",
  "message.read_receipt.view",
  "search.advanced.use",
  "likes.received.view",
  "profile.visitors.view",
  "profile.incognito.use",
  "translation.message.use",
  "ranking.boost.multiplier",
  "super_like.monthly",
] as const;

export type EntitlementKey = typeof PUBLIC_ENTITLEMENT_KEYS[number];
export type EntitlementKind = "boolean" | "quota" | "numeric";
export type ResetPeriod = "none" | "daily" | "monthly";
export type EntitlementReason =
  | "SAFETY_RESTRICTED"
  | "VERIFICATION_REQUIRED"
  | "FEATURE_DISABLED"
  | "NOT_INCLUDED"
  | "LIMIT_REACHED";

export const ENTITLEMENT_CATALOG: Readonly<Record<EntitlementKey, {
  kind: EntitlementKind;
  resetPeriod: ResetPeriod;
}>> = {
  "message.send.daily": { kind: "quota", resetPeriod: "daily" },
  "message.read_receipt.view": { kind: "boolean", resetPeriod: "none" },
  "search.advanced.use": { kind: "boolean", resetPeriod: "none" },
  "likes.received.view": { kind: "boolean", resetPeriod: "none" },
  "profile.visitors.view": { kind: "boolean", resetPeriod: "none" },
  "profile.incognito.use": { kind: "boolean", resetPeriod: "none" },
  "translation.message.use": { kind: "quota", resetPeriod: "monthly" },
  "ranking.boost.multiplier": { kind: "numeric", resetPeriod: "none" },
  "super_like.monthly": { kind: "quota", resetPeriod: "monthly" },
};

export type EntitlementPolicy = {
  safetyAllowed: boolean;
  verificationSatisfied: boolean;
};

export type EntitlementGrant = {
  kind: EntitlementKind;
  enabled: boolean;
  booleanValue: boolean | null;
  quotaLimit: number | null;
  numericValue: number | null;
  resetPeriod: ResetPeriod;
  upgradeHint: string | null;
};

export type ResolvedEntitlementSources = {
  globalEnabled: boolean;
  userOverride: EntitlementGrant | null;
  planBenefit: EntitlementGrant | null;
  freeDefault: EntitlementGrant | null;
  used: number;
};

export type EntitlementDecision = {
  key: EntitlementKey;
  kind: EntitlementKind;
  allowed: boolean;
  value: boolean | number | null;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  reason: EntitlementReason | null;
  upgradeHint: string | null;
};

export type ResolveEntitlementInput = {
  userId: string;
  key: EntitlementKey;
  planRef?: string | null;
  now: Date;
};

export type ConsumeEntitlementInput = ResolveEntitlementInput & {
  operationId: string;
  amount: number;
  context: Readonly<Record<string, string | number | boolean | null>>;
  policy: EntitlementPolicy;
};

export interface EntitlementStore {
  resolve(input: ResolveEntitlementInput): Promise<ResolvedEntitlementSources>;
  consume(input: ConsumeEntitlementInput): Promise<EntitlementDecision>;
}

export interface EntitlementCache {
  get(userId: string, key: EntitlementKey): Promise<unknown | null>;
  set(userId: string, key: EntitlementKey, decision: EntitlementDecision): Promise<void>;
}

export type EntitlementAuthorizer = (userId: string, key: EntitlementKey) => Promise<boolean>;
