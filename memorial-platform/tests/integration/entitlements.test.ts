import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  memorialEntitlements,
  memorials,
  orders,
  outboxEvents,
  planEntitlements,
  plans,
  subscriptions,
  users,
} from "@/db/schema";
import { FEATURE_KEYS, FREE_PLAN_SLUG, seedPlans } from "@/db/seed/plans";
import {
  entitlementFlag,
  entitlementNumber,
  grantMemorialEntitlement,
  grantSubscription,
  resolveEntitlement,
} from "@/modules/entitlements/service";
import { createMemorial } from "@/modules/memorials/service";
import type { Actor } from "@/modules/permissions/types";

const createdUserIds: string[] = [];
const createdPlanIds: string[] = [];
let superAdmin: Actor;
let reviewer: Actor;

beforeAll(async () => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
  await seedPlans();

  const [admin] = await db()
    .insert(users)
    .values({ displayName: "Super admin" })
    .returning({ id: users.id });
  const [staff] = await db()
    .insert(users)
    .values({ displayName: "Reviewer" })
    .returning({ id: users.id });
  if (!admin || !staff) throw new Error("user insert returned no row");

  superAdmin = { userId: admin.id, platformRole: "super_admin" };
  reviewer = { userId: staff.id, platformRole: "reviewer" };
});

afterEach(async () => {
  const userIds = createdUserIds.splice(0);
  if (userIds.length === 0) return;

  const owned = await db()
    .select({ id: memorials.id, personId: memorials.deceasedPersonId })
    .from(memorials)
    .where(inArray(memorials.ownerUserId, userIds));
  const memorialIds = owned.map((row) => row.id);

  if (memorialIds.length > 0) {
    await db()
      .delete(memorialEntitlements)
      .where(inArray(memorialEntitlements.memorialId, memorialIds));
    await db().delete(auditLogs).where(inArray(auditLogs.resourceId, memorialIds));
    await db()
      .delete(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, memorialIds));
    await db().delete(memorials).where(inArray(memorials.id, memorialIds));
    await db()
      .delete(deceasedPeople)
      .where(inArray(deceasedPeople.id, owned.map((row) => row.personId)));
  }

  await db().delete(subscriptions).where(inArray(subscriptions.userId, userIds));
  await db().delete(auditLogs).where(inArray(auditLogs.resourceId, userIds));
  await db().delete(users).where(inArray(users.id, userIds));
});

afterAll(async () => {
  if (createdPlanIds.length > 0) {
    await db()
      .delete(planEntitlements)
      .where(inArray(planEntitlements.planId, createdPlanIds));
    await db().delete(plans).where(inArray(plans.id, createdPlanIds));
  }
  await db()
    .delete(users)
    .where(inArray(users.id, [superAdmin.userId ?? "", reviewer.userId ?? ""]));
  await closeDb();
});

async function makeActor(): Promise<Actor> {
  const [row] = await db()
    .insert(users)
    .values({ displayName: `Person ${randomUUID().slice(0, 8)}` })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no row");
  createdUserIds.push(row.id);
  return { userId: row.id, platformRole: "user" };
}

async function makeMemorial(
  owner?: Actor,
): Promise<{ owner: Actor; memorialId: string }> {
  const actor = owner ?? (await makeActor());
  const result = await createMemorial(
    actor,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");
  return { owner: actor, memorialId: result.value.memorialId };
}

describe("the free plan", () => {
  it("is the default and costs nothing", async () => {
    const [plan] = await db()
      .select()
      .from(plans)
      .where(eq(plans.slug, FREE_PLAN_SLUG));

    expect(plan?.isDefault).toBe(true);
    expect(plan?.status).toBe("active");
    // Nothing is for sale, so nothing carries a price.
    expect(plan?.priceMinor).toBeNull();
    expect(plan?.currency).toBeNull();
  });

  it("is the only plan that exists", async () => {
    // Doc 01 section 4.5: phase one shows no purchase entry.
    const rows = await db().select().from(plans);
    const paid = rows.filter((row) => row.priceMinor !== null);

    expect(paid).toHaveLength(0);
  });

  it("grants one memorial", async () => {
    const { memorialId } = await makeMemorial();

    const result = await entitlementNumber(
      memorialId,
      FEATURE_KEYS.memorialsMax,
    );
    expect(result.ok && result.value.value).toBe(1);
    expect(result.ok && result.value.source).toBe("default_plan");
  });

  it("grants two family managers", async () => {
    const { memorialId } = await makeMemorial();

    const result = await entitlementNumber(memorialId, FEATURE_KEYS.maxAdmins);
    expect(result.ok && result.value.value).toBe(2);
  });

  it("grants the basic ways of remembering", async () => {
    // Doc 01 section 4.5 makes these free forever, not a trial.
    const { memorialId } = await makeMemorial();

    const result = await entitlementFlag(memorialId, FEATURE_KEYS.baseRituals);
    expect(result.ok && result.value.value).toBe(true);
  });

  it("lets a family export their own memorial", async () => {
    const { memorialId } = await makeMemorial();

    const result = await entitlementFlag(memorialId, FEATURE_KEYS.exportEnabled);
    expect(result.ok && result.value.value).toBe(true);
  });

  it("gives real storage rather than a token amount", async () => {
    // A family hitting an invented ceiling while uploading photographs of
    // someone who has just died is a worse failure than paying for storage.
    const { memorialId } = await makeMemorial();

    const storage = await entitlementNumber(
      memorialId,
      FEATURE_KEYS.storageBytes,
    );
    expect(storage.ok && storage.value.value).toBeGreaterThanOrEqual(
      1024 * 1024 * 1024,
    );
  });

  it("leaves the reserved features off", async () => {
    const { memorialId } = await makeMemorial();

    for (const key of [
      FEATURE_KEYS.customDomain,
      FEATURE_KEYS.visitorAnalytics,
      FEATURE_KEYS.anniversaryReminders,
    ]) {
      const result = await entitlementFlag(memorialId, key);
      expect(result.ok && result.value.value).toBe(false);
    }
  });
});

describe("resolution order", () => {
  it("prefers a grant to this memorial over everything else", async () => {
    // Doc 03 section 8. Support giving one family more room must not look like
    // the platform's default.
    const { memorialId } = await makeMemorial();

    await grantMemorialEntitlement(
      superAdmin,
      {
        memorialId,
        featureKey: FEATURE_KEYS.storageBytes,
        value: String(50 * 1024 * 1024 * 1024),
        reason: "The family has forty years of photographs.",
      },
      "r1",
    );

    const result = await entitlementNumber(
      memorialId,
      FEATURE_KEYS.storageBytes,
    );
    expect(result.ok && result.value.value).toBe(50 * 1024 * 1024 * 1024);
    expect(result.ok && result.value.source).toBe("memorial_override");
  });

  it("falls back to the default plan once a grant expires", async () => {
    const { memorialId } = await makeMemorial();

    await grantMemorialEntitlement(
      superAdmin,
      {
        memorialId,
        featureKey: FEATURE_KEYS.maxAdmins,
        value: "10",
        reason: "Temporary, for the funeral week.",
        expiresAt: new Date(Date.now() - 1000),
      },
      "r1",
    );

    const result = await entitlementNumber(memorialId, FEATURE_KEYS.maxAdmins);
    expect(result.ok && result.value.value).toBe(2);
    expect(result.ok && result.value.source).toBe("default_plan");
  });

  it("uses an active subscription when there is no memorial grant", async () => {
    const owner = await makeActor();
    const { memorialId } = await makeMemorial(owner);

    const [plan] = await db()
      .insert(plans)
      .values({
        slug: `supporter-${randomUUID().slice(0, 8)}`,
        adminLabel: "Supporter",
        status: "active",
        isDefault: false,
      })
      .returning({ id: plans.id });
    if (!plan) throw new Error("plan insert failed");
    createdPlanIds.push(plan.id);

    const [feature] = await db()
      .select()
      .from(planEntitlements)
      .where(eq(planEntitlements.value, "2"));
    if (!feature) throw new Error("expected the free admin entitlement");

    await db()
      .insert(planEntitlements)
      .values({ planId: plan.id, featureId: feature.featureId, value: "8" });

    const [planRow] = await db()
      .select({ slug: plans.slug })
      .from(plans)
      .where(eq(plans.id, plan.id));

    await grantSubscription(
      superAdmin,
      { userId: owner.userId ?? "", planSlug: planRow?.slug ?? "" },
      "r1",
    );

    const result = await entitlementNumber(memorialId, FEATURE_KEYS.maxAdmins);
    expect(result.ok && result.value.value).toBe(8);
    expect(result.ok && result.value.source).toBe("subscription");
  });

  it("ignores a cancelled subscription", async () => {
    const owner = await makeActor();
    const { memorialId } = await makeMemorial(owner);

    const granted = await grantSubscription(
      superAdmin,
      { userId: owner.userId ?? "", planSlug: FREE_PLAN_SLUG },
      "r1",
    );
    if (!granted.ok) throw new Error("grant failed");

    await db()
      .update(subscriptions)
      .set({ status: "cancelled" })
      .where(eq(subscriptions.id, granted.value.subscriptionId));

    const result = await entitlementNumber(memorialId, FEATURE_KEYS.maxAdmins);
    expect(result.ok && result.value.source).toBe("default_plan");
  });

  it("reports an unknown feature rather than refusing", async () => {
    // A typo must not be hidden behind a plausible-looking denial.
    const { memorialId } = await makeMemorial();

    expect(await resolveEntitlement(memorialId, "no.such.feature")).toEqual({
      ok: false,
      error: "UNKNOWN_FEATURE",
    });
  });

  it("reports a memorial that does not exist", async () => {
    expect(
      await resolveEntitlement(randomUUID(), FEATURE_KEYS.maxAdmins),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });
});

describe("granting extra room", () => {
  it("is refused to the family themselves", async () => {
    const { owner, memorialId } = await makeMemorial();

    expect(
      await grantMemorialEntitlement(
        owner,
        {
          memorialId,
          featureKey: FEATURE_KEYS.storageBytes,
          value: "999999999999",
          reason: "I would like more.",
        },
        "r1",
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("is refused to a platform reviewer", async () => {
    // Held at the same bar as changing a platform switch.
    const { memorialId } = await makeMemorial();

    expect(
      await grantMemorialEntitlement(
        reviewer,
        {
          memorialId,
          featureKey: FEATURE_KEYS.maxAdmins,
          value: "5",
          reason: "Support request.",
        },
        "r1",
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("records who granted it and why", async () => {
    const { memorialId } = await makeMemorial();

    await grantMemorialEntitlement(
      superAdmin,
      {
        memorialId,
        featureKey: FEATURE_KEYS.maxAdmins,
        value: "6",
        reason: "Six siblings are sharing the arrangements.",
      },
      "req_grant",
    );

    const [row] = await db()
      .select()
      .from(memorialEntitlements)
      .where(eq(memorialEntitlements.memorialId, memorialId));

    expect(row?.grantedByUserId).toBe(superAdmin.userId);
    expect(row?.reason).toBe("Six siblings are sharing the arrangements.");

    const [entry] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, "req_grant"));
    expect(entry?.action).toBe("entitlement.granted");
  });

  it("replaces an earlier grant rather than stacking", async () => {
    const { memorialId } = await makeMemorial();

    await grantMemorialEntitlement(
      superAdmin,
      {
        memorialId,
        featureKey: FEATURE_KEYS.maxAdmins,
        value: "4",
        reason: "First request.",
      },
      "r1",
    );
    await grantMemorialEntitlement(
      superAdmin,
      {
        memorialId,
        featureKey: FEATURE_KEYS.maxAdmins,
        value: "7",
        reason: "They asked again.",
      },
      "r2",
    );

    const rows = await db()
      .select()
      .from(memorialEntitlements)
      .where(eq(memorialEntitlements.memorialId, memorialId));
    expect(rows).toHaveLength(1);

    const result = await entitlementNumber(memorialId, FEATURE_KEYS.maxAdmins);
    expect(result.ok && result.value.value).toBe(7);
  });
});

describe("nothing is sold", () => {
  it("has no order in the database", async () => {
    // Phase one creates none. If this ever fails, a payment path appeared
    // without the decisions in doc 11 section 1 having been made.
    const rows = await db().select().from(orders);
    expect(rows).toHaveLength(0);
  });

  it("creates no order when a subscription is granted", async () => {
    const owner = await makeActor();

    await grantSubscription(
      superAdmin,
      { userId: owner.userId ?? "", planSlug: FREE_PLAN_SLUG },
      "r1",
    );

    expect(await db().select().from(orders)).toHaveLength(0);
  });

  it("only lets staff grant a subscription", async () => {
    const owner = await makeActor();

    expect(
      await grantSubscription(
        owner,
        { userId: owner.userId ?? "", planSlug: FREE_PLAN_SLUG },
        "r1",
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});

describe("the seed", () => {
  it("can be run again without changing anything", async () => {
    const before = await db().select().from(plans);
    await seedPlans();
    const after = await db().select().from(plans);

    expect(after.length).toBe(before.length);
  });
});
