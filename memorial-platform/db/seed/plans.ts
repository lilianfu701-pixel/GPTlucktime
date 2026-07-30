import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { features, planEntitlements, plans } from "@/db/schema";

/**
 * The free plan, and the vocabulary of things a plan can grant.
 *
 * Doc 01 section 4.5 makes a basic memorial and basic commemorations free
 * forever. Nothing here is sold; the numbers are engineering defaults chosen so
 * the platform behaves sensibly, and doc 11 section 6 leaves the real figures to
 * the product decision that is still open.
 *
 * The defaults are deliberately generous rather than tight. A family hitting an
 * invented ceiling while uploading photographs of someone who has just died is a
 * worse failure than paying for storage we did not need to ration.
 */

const MB = 1024 * 1024;

export const FEATURE_KEYS = {
  memorialsMax: "memorials.max",
  storageBytes: "media.storage_bytes",
  maxFileBytes: "media.max_file_bytes",
  maxAdmins: "members.max_admins",
  baseRituals: "rituals.base",
  exportEnabled: "export.enabled",
  exportsPerMonth: "export.per_month",
  customDomain: "branding.custom_domain",
  visitorAnalytics: "analytics.visitors",
  anniversaryReminders: "notifications.anniversary",
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

const FEATURES: {
  key: FeatureKey;
  valueType: "integer" | "boolean" | "string";
  description: string;
}[] = [
  {
    key: FEATURE_KEYS.memorialsMax,
    valueType: "integer",
    description: "How many memorials one account may create.",
  },
  {
    key: FEATURE_KEYS.storageBytes,
    valueType: "integer",
    description: "Total media stored for one memorial.",
  },
  {
    key: FEATURE_KEYS.maxFileBytes,
    valueType: "integer",
    description: "Largest single upload.",
  },
  {
    key: FEATURE_KEYS.maxAdmins,
    valueType: "integer",
    description: "Family members who may help manage a memorial.",
  },
  {
    key: FEATURE_KEYS.baseRituals,
    valueType: "boolean",
    description: "Whether the family may offer the basic ways of remembering.",
  },
  {
    key: FEATURE_KEYS.exportEnabled,
    valueType: "boolean",
    description: "Whether the family may export their own memorial.",
  },
  {
    key: FEATURE_KEYS.exportsPerMonth,
    valueType: "integer",
    description: "How often an export may be requested.",
  },
  {
    key: FEATURE_KEYS.customDomain,
    valueType: "boolean",
    description: "Reserved for a later paid tier.",
  },
  {
    key: FEATURE_KEYS.visitorAnalytics,
    valueType: "boolean",
    description: "Reserved for a later paid tier.",
  },
  {
    key: FEATURE_KEYS.anniversaryReminders,
    valueType: "boolean",
    description: "Reserved; also gated by a platform feature switch.",
  },
];

export const FREE_PLAN_SLUG = "free";

/**
 * What every family gets without paying, and keeps.
 *
 * `memorials.max` is 1 per doc 01 section 4.5. It is a soft product default, not
 * a safety control: someone who loses two relatives asks support and is given
 * more, which is what memorial entitlements are for.
 */
const FREE_ENTITLEMENTS: { key: FeatureKey; value: string }[] = [
  { key: FEATURE_KEYS.memorialsMax, value: "1" },
  { key: FEATURE_KEYS.storageBytes, value: String(2048 * MB) },
  { key: FEATURE_KEYS.maxFileBytes, value: String(500 * MB) },
  { key: FEATURE_KEYS.maxAdmins, value: "2" },
  { key: FEATURE_KEYS.baseRituals, value: "true" },
  { key: FEATURE_KEYS.exportEnabled, value: "true" },
  { key: FEATURE_KEYS.exportsPerMonth, value: "4" },
  // Reserved, and off. No purchase path exists to turn them on.
  { key: FEATURE_KEYS.customDomain, value: "false" },
  { key: FEATURE_KEYS.visitorAnalytics, value: "false" },
  { key: FEATURE_KEYS.anniversaryReminders, value: "false" },
];

export type PlanSeedCounts = {
  features: number;
  plans: number;
  freeEntitlements: number;
  paidPlans: number;
};

/** Inserts the feature vocabulary and the free plan. Safe to run repeatedly. */
export async function seedPlans(): Promise<PlanSeedCounts> {
  await db()
    .insert(features)
    .values(FEATURES)
    .onConflictDoNothing({ target: features.key });

  await db()
    .insert(plans)
    .values({
      slug: FREE_PLAN_SLUG,
      adminLabel: "Free",
      status: "active",
      isDefault: true,
      // No price. Nothing is for sale.
      priceMinor: null,
      currency: null,
    })
    .onConflictDoNothing({ target: plans.slug });

  const [freePlan] = await db()
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.slug, FREE_PLAN_SLUG));

  if (!freePlan) {
    throw new Error("the free plan is required");
  }

  const featureRows = await db()
    .select({ id: features.id, key: features.key })
    .from(features);
  const idByKey = new Map(featureRows.map((row) => [row.key, row.id]));

  for (const entitlement of FREE_ENTITLEMENTS) {
    const featureId = idByKey.get(entitlement.key);
    if (!featureId) {
      throw new Error(`feature ${entitlement.key} was not seeded`);
    }

    await db()
      .insert(planEntitlements)
      .values({ planId: freePlan.id, featureId, value: entitlement.value })
      .onConflictDoUpdate({
        target: [planEntitlements.planId, planEntitlements.featureId],
        set: { value: entitlement.value },
      });
  }

  return {
    features: FEATURES.length,
    plans: 1,
    freeEntitlements: FREE_ENTITLEMENTS.length,
    // Stated so a reader of the seed output sees that nothing is purchasable.
    paidPlans: 0,
  };
}
