import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  features,
  memorialEntitlements,
  memorials,
  planEntitlements,
  plans,
  subscriptions,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canGovern } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import type { FeatureKey } from "@/db/seed/plans";

export type EntitlementSource =
  | "memorial_override"
  | "subscription"
  | "default_plan";

export type ResolvedEntitlement = {
  key: string;
  source: EntitlementSource;
  raw: string;
};

export type EntitlementError =
  | "UNKNOWN_FEATURE"
  | "NO_DEFAULT_PLAN"
  | "MEMORIAL_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "FORBIDDEN";

/**
 * Works out what a memorial is allowed, and where the answer came from.
 *
 * The order is fixed by doc 03 section 8: an entitlement granted to this
 * memorial wins, then the owner's active subscription, then the default plan.
 *
 * The source travels with the value on purpose. When support has given one
 * family extra room, that has to be visible as a deliberate grant rather than
 * looking like the platform's default.
 */
export async function resolveEntitlement(
  memorialId: string,
  featureKey: FeatureKey | string,
): Promise<Result<ResolvedEntitlement, EntitlementError>> {
  const [feature] = await db()
    .select({ id: features.id, key: features.key })
    .from(features)
    .where(eq(features.key, featureKey));

  if (!feature) {
    // Asking for something that does not exist is a programming mistake, not a
    // denial. Returning "not allowed" would hide a typo behind a plausible
    // refusal.
    return err("UNKNOWN_FEATURE");
  }

  const [memorial] = await db()
    .select({ ownerUserId: memorials.ownerUserId })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  const now = new Date();

  const [override] = await db()
    .select({ value: memorialEntitlements.value })
    .from(memorialEntitlements)
    .where(
      and(
        eq(memorialEntitlements.memorialId, memorialId),
        eq(memorialEntitlements.featureId, feature.id),
        or(
          isNull(memorialEntitlements.expiresAt),
          gt(memorialEntitlements.expiresAt, now),
        ),
      ),
    );

  if (override) {
    return ok({
      key: feature.key,
      source: "memorial_override",
      raw: override.value,
    });
  }

  const [subscribed] = await db()
    .select({ value: planEntitlements.value })
    .from(subscriptions)
    .innerJoin(planEntitlements, eq(planEntitlements.planId, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.userId, memorial.ownerUserId),
        eq(subscriptions.status, "active"),
        eq(planEntitlements.featureId, feature.id),
        or(isNull(subscriptions.endsAt), gt(subscriptions.endsAt, now)),
      ),
    );

  if (subscribed) {
    return ok({
      key: feature.key,
      source: "subscription",
      raw: subscribed.value,
    });
  }

  const [fallback] = await db()
    .select({ value: planEntitlements.value })
    .from(plans)
    .innerJoin(planEntitlements, eq(planEntitlements.planId, plans.id))
    .where(
      and(
        eq(plans.isDefault, true),
        eq(plans.status, "active"),
        eq(planEntitlements.featureId, feature.id),
      ),
    );

  if (!fallback) {
    // Better to fail loudly than to invent a limit for a family.
    return err("NO_DEFAULT_PLAN");
  }

  return ok({ key: feature.key, source: "default_plan", raw: fallback.value });
}

/** A numeric entitlement, or the supplied fallback when it cannot be resolved. */
export async function entitlementNumber(
  memorialId: string,
  featureKey: FeatureKey | string,
): Promise<Result<{ value: number; source: EntitlementSource }, EntitlementError>> {
  const resolved = await resolveEntitlement(memorialId, featureKey);
  if (!resolved.ok) {
    return err(resolved.error);
  }

  const value = Number.parseInt(resolved.value.raw, 10);
  if (!Number.isFinite(value)) {
    return err("UNKNOWN_FEATURE");
  }

  return ok({ value, source: resolved.value.source });
}

/** A boolean entitlement. Anything that is not exactly `true` is false. */
export async function entitlementFlag(
  memorialId: string,
  featureKey: FeatureKey | string,
): Promise<Result<{ value: boolean; source: EntitlementSource }, EntitlementError>> {
  const resolved = await resolveEntitlement(memorialId, featureKey);
  if (!resolved.ok) {
    return err(resolved.error);
  }

  return ok({
    value: resolved.value.raw === "true",
    source: resolved.value.source,
  });
}

/**
 * Grants one memorial more than the plan allows.
 *
 * A staff action, with a reason. This is how a family who needs more room gets
 * it in phase one: by asking, not by paying. No route in this application
 * charges anyone, and none creates an order.
 */
export async function grantMemorialEntitlement(
  actor: Actor,
  input: {
    memorialId: string;
    featureKey: FeatureKey | string;
    value: string;
    reason: string;
    expiresAt?: Date | undefined;
  },
  correlationId: string,
): Promise<Result<{ granted: true }, EntitlementError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  // Deliberately the same bar as changing a platform switch: an entitlement
  // grant changes what one family may do, and should be as traceable.
  if (!canGovern({ actor, action: "change_feature_flag" })) {
    return err("FORBIDDEN");
  }

  const [feature] = await db()
    .select({ id: features.id })
    .from(features)
    .where(eq(features.key, input.featureKey));

  if (!feature) {
    return err("UNKNOWN_FEATURE");
  }

  const [memorial] = await db()
    .select({ id: memorials.id })
    .from(memorials)
    .where(eq(memorials.id, input.memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  await db().transaction(async (tx) => {
    await tx
      .insert(memorialEntitlements)
      .values({
        memorialId: input.memorialId,
        featureId: feature.id,
        value: input.value,
        grantedByUserId: actor.userId,
        reason: input.reason,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoUpdate({
        target: [
          memorialEntitlements.memorialId,
          memorialEntitlements.featureId,
        ],
        set: {
          value: input.value,
          grantedByUserId: actor.userId,
          reason: input.reason,
          expiresAt: input.expiresAt ?? null,
        },
      });

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "entitlement.granted",
      resourceType: "memorial",
      resourceId: input.memorialId,
      newValue: { feature: input.featureKey, value: input.value },
      reason: input.reason,
      correlationId,
    });
  });

  return ok({ granted: true });
}

/**
 * Puts an account on a plan without any money changing hands.
 *
 * The only way a subscription exists in phase one. There is no checkout, and
 * `orders` is never written by application code.
 */
export async function grantSubscription(
  actor: Actor,
  input: { userId: string; planSlug: string; endsAt?: Date | undefined },
  correlationId: string,
): Promise<Result<{ subscriptionId: string }, EntitlementError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  if (!canGovern({ actor, action: "change_feature_flag" })) {
    return err("FORBIDDEN");
  }

  const [plan] = await db()
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.slug, input.planSlug));

  if (!plan) {
    return err("UNKNOWN_FEATURE");
  }

  const [row] = await db()
    .insert(subscriptions)
    .values({
      userId: input.userId,
      planId: plan.id,
      status: "active",
      endsAt: input.endsAt ?? null,
      grantedByUserId: actor.userId,
    })
    .returning({ id: subscriptions.id });

  if (!row) {
    throw new Error("subscription insert returned no row");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "subscription.granted",
    resourceType: "user",
    resourceId: input.userId,
    newValue: { planSlug: input.planSlug },
    correlationId,
  });

  return ok({ subscriptionId: row.id });
}
