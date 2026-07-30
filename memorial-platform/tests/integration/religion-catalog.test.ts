import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  culturalTraditions,
  denominations,
  religions,
  ritualDefinitions,
  ritualSources,
  ritualTranslations,
  ritualVersions,
  users,
} from "@/db/schema";
import { seedReligions } from "@/db/seed/religions";
import {
  adoptableVersions,
  createDraftVersion,
  markReviewed,
  publishRitualVersion,
  publishedTranslation,
  retireRitualVersion,
} from "@/modules/religion/catalog";
import type { Actor } from "@/modules/permissions/types";

const ordinaryUser: Actor = { userId: "user-1", platformRole: "user" };
const reviewer: Actor = { userId: "staff-1", platformRole: "reviewer" };
const superAdmin: Actor = { userId: "admin-1", platformRole: "super_admin" };

let staffUserId: string;
let adminUserId: string;
let religionId: string;
let definitionId: string;
const createdUserIds: string[] = [];
const createdDefinitionIds: string[] = [];

beforeAll(async () => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
  await seedReligions();

  const [staff] = await db()
    .insert(users)
    .values({ displayName: "Reviewer" })
    .returning({ id: users.id });
  const [admin] = await db()
    .insert(users)
    .values({ displayName: "Super admin" })
    .returning({ id: users.id });
  if (!staff || !admin) throw new Error("user insert returned no row");

  staffUserId = staff.id;
  adminUserId = admin.id;
  createdUserIds.push(staff.id, admin.id);

  reviewer.userId = staff.id;
  superAdmin.userId = admin.id;

  const [religion] = await db()
    .select({ id: religions.id })
    .from(religions)
    .where(eq(religions.slug, "buddhist"));
  if (!religion) throw new Error("expected the seeded classification");
  religionId = religion.id;
});

afterAll(async () => {
  if (createdDefinitionIds.length > 0) {
    const versions = await db()
      .select({ id: ritualVersions.id })
      .from(ritualVersions)
      .where(inArray(ritualVersions.definitionId, createdDefinitionIds));
    const versionIds = versions.map((row) => row.id);
    if (versionIds.length > 0) {
      await db()
        .delete(auditLogs)
        .where(inArray(auditLogs.resourceId, versionIds));
    }
    await db()
      .delete(ritualDefinitions)
      .where(inArray(ritualDefinitions.id, createdDefinitionIds));
  }
  if (createdUserIds.length > 0) {
    await db().delete(users).where(inArray(users.id, createdUserIds));
  }
  await closeDb();
});

/** A fresh definition per test, so versions never collide across tests. */
async function makeDefinition(): Promise<string> {
  const [row] = await db()
    .insert(ritualDefinitions)
    .values({
      slug: `test-ritual-${randomUUID()}`,
      actionType: "offering",
      adminLabel: "Test ritual",
    })
    .returning({ id: ritualDefinitions.id });
  if (!row) throw new Error("definition insert returned no row");
  createdDefinitionIds.push(row.id);
  definitionId = row.id;
  return row.id;
}

/** Brings a draft to the point where only the publication gates remain. */
async function readyToPublish(): Promise<string> {
  const defId = await makeDefinition();
  const draft = await createDraftVersion(
    reviewer,
    { definitionId: defId, appliesToReligionId: religionId },
    "req_draft",
  );
  if (!draft.ok) throw new Error(`draft failed: ${draft.error}`);

  await db().insert(ritualSources).values({
    ritualVersionId: draft.value.versionId,
    kind: "scholarly",
    citation: "A reviewed citation supplied by an adviser.",
  });
  await db().insert(ritualTranslations).values({
    ritualVersionId: draft.value.versionId,
    locale: "en",
    name: "A way of remembering",
    description: "Described by a named reviewer.",
    method: "human",
  });
  await markReviewed(reviewer, draft.value.versionId, "req_review");

  return draft.value.versionId;
}

describe("the seeded catalogue", () => {
  it("separates religion, denomination and culture", async () => {
    // Doc 05 section 2: describing one denomination's custom as the whole
    // religion's rule is the failure this modelling exists to prevent.
    const religionRows = await db().select().from(religions);
    const cultureRows = await db().select().from(culturalTraditions);
    const denominationRows = await db().select().from(denominations);

    expect(religionRows.length).toBeGreaterThanOrEqual(14);
    expect(cultureRows.length).toBeGreaterThanOrEqual(12);
    // Denominations exist as a table and are filled by advisers, not by a seed.
    expect(Array.isArray(denominationRows)).toBe(true);
  });

  it("covers every classification named in the specification", async () => {
    const slugs = (await db().select({ slug: religions.slug }).from(religions)).map(
      (row) => row.slug,
    );

    for (const expected of [
      "secular",
      "christian",
      "muslim",
      "buddhist",
      "taoist-chinese-folk",
      "hindu",
      "jewish",
      "sikh",
      "shinto",
      "bahai",
      "indigenous-local",
      "multi-tradition",
      "family-custom",
      "undisclosed",
    ]) {
      expect(slugs).toContain(expected);
    }
  });

  it("seeds no ritual version at all", async () => {
    // The point of the seed: classifications exist, claims do not. With no
    // published version the platform offers no ritual to any family, which is
    // correct until the advisers in doc 11 section 4 are appointed.
    const seeded = await db()
      .select({ id: ritualVersions.id, definitionId: ritualVersions.definitionId })
      .from(ritualVersions);

    const fromSeed = seeded.filter(
      (row) => !createdDefinitionIds.includes(row.definitionId),
    );
    expect(fromSeed).toHaveLength(0);
  });

  it("can be run again without changing anything", async () => {
    const before = await db().select({ slug: religions.slug }).from(religions);
    await seedReligions();
    const after = await db().select({ slug: religions.slug }).from(religions);

    expect(after.length).toBe(before.length);
  });
});

describe("who may author catalogue content", () => {
  it("refuses an ordinary user", async () => {
    const defId = await makeDefinition();
    expect(
      await createDraftVersion(ordinaryUser, { definitionId: defId }, "r1"),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("refuses an anonymous caller", async () => {
    const defId = await makeDefinition();
    expect(
      await createDraftVersion(
        { userId: null, platformRole: "super_admin" },
        { definitionId: defId },
        "r1",
      ),
    ).toEqual({ ok: false, error: "AUTH_REQUIRED" });
  });

  it("allows staff", async () => {
    const defId = await makeDefinition();
    expect(
      (await createDraftVersion(reviewer, { definitionId: defId }, "r1")).ok,
    ).toBe(true);
  });
});

describe("version numbering", () => {
  it("starts at one and increases", async () => {
    const defId = await makeDefinition();

    const first = await createDraftVersion(reviewer, { definitionId: defId }, "r1");
    const second = await createDraftVersion(reviewer, { definitionId: defId }, "r2");

    expect(first.ok && first.value.version).toBe(1);
    expect(second.ok && second.value.version).toBe(2);
  });

  it("records who authored the draft", async () => {
    const defId = await makeDefinition();
    const draft = await createDraftVersion(reviewer, { definitionId: defId }, "r1");
    if (!draft.ok) throw new Error("draft failed");

    const [row] = await db()
      .select()
      .from(ritualVersions)
      .where(eq(ritualVersions.id, draft.value.versionId));

    expect(row?.authoredByUserId).toBe(staffUserId);
    expect(row?.status).toBe("draft");
  });
});

describe("publication gates", () => {
  it("is reserved for a super admin", async () => {
    // A published version becomes a statement about someone's faith, so it sits
    // above the day-to-day moderation bar even among staff.
    const versionId = await readyToPublish();

    expect(await publishRitualVersion(reviewer, versionId, "r1")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
    expect((await publishRitualVersion(superAdmin, versionId, "r2")).ok).toBe(true);
  });

  it("refuses a version with no source", async () => {
    // Without a citation the rule is the platform's own assertion about a faith.
    const defId = await makeDefinition();
    const draft = await createDraftVersion(
      reviewer,
      { definitionId: defId, appliesToReligionId: religionId },
      "r1",
    );
    if (!draft.ok) throw new Error("draft failed");

    await db().insert(ritualTranslations).values({
      ritualVersionId: draft.value.versionId,
      locale: "en",
      name: "Name",
      description: "Description",
      method: "human",
    });
    await markReviewed(reviewer, draft.value.versionId, "r2");

    expect(
      await publishRitualVersion(superAdmin, draft.value.versionId, "r3"),
    ).toEqual({ ok: false, error: "NO_SOURCE" });
  });

  it("refuses a version with no applicability scope", async () => {
    // With no scope it silently speaks for every believer everywhere.
    const defId = await makeDefinition();
    const draft = await createDraftVersion(reviewer, { definitionId: defId }, "r1");
    if (!draft.ok) throw new Error("draft failed");

    await db().insert(ritualSources).values({
      ritualVersionId: draft.value.versionId,
      kind: "scholarly",
      citation: "A citation.",
    });
    await db().insert(ritualTranslations).values({
      ritualVersionId: draft.value.versionId,
      locale: "en",
      name: "Name",
      description: "Description",
      method: "human",
    });
    await markReviewed(reviewer, draft.value.versionId, "r2");

    expect(
      await publishRitualVersion(superAdmin, draft.value.versionId, "r3"),
    ).toEqual({ ok: false, error: "NO_APPLICABILITY_SCOPE" });
  });

  it("accepts a country-only scope", async () => {
    const defId = await makeDefinition();
    const draft = await createDraftVersion(
      reviewer,
      { definitionId: defId, appliesToCountries: ["JP"] },
      "r1",
    );
    if (!draft.ok) throw new Error("draft failed");

    await db().insert(ritualSources).values({
      ritualVersionId: draft.value.versionId,
      kind: "ethnographic",
      citation: "A citation.",
    });
    await db().insert(ritualTranslations).values({
      ritualVersionId: draft.value.versionId,
      locale: "en",
      name: "Name",
      description: "Description",
      method: "human",
    });
    await markReviewed(reviewer, draft.value.versionId, "r2");

    expect(
      (await publishRitualVersion(superAdmin, draft.value.versionId, "r3")).ok,
    ).toBe(true);
  });

  it("refuses a version nobody reviewed", async () => {
    const defId = await makeDefinition();
    const draft = await createDraftVersion(
      reviewer,
      { definitionId: defId, appliesToReligionId: religionId },
      "r1",
    );
    if (!draft.ok) throw new Error("draft failed");

    await db().insert(ritualSources).values({
      ritualVersionId: draft.value.versionId,
      kind: "scholarly",
      citation: "A citation.",
    });
    await db().insert(ritualTranslations).values({
      ritualVersionId: draft.value.versionId,
      locale: "en",
      name: "Name",
      description: "Description",
      method: "human",
    });

    expect(
      await publishRitualVersion(superAdmin, draft.value.versionId, "r2"),
    ).toEqual({ ok: false, error: "NO_REVIEWER" });
  });

  it("refuses a version whose only translation is machine-made", async () => {
    // Doc 05 section 7: a machine may draft, a person takes responsibility.
    const defId = await makeDefinition();
    const draft = await createDraftVersion(
      reviewer,
      { definitionId: defId, appliesToReligionId: religionId },
      "r1",
    );
    if (!draft.ok) throw new Error("draft failed");

    await db().insert(ritualSources).values({
      ritualVersionId: draft.value.versionId,
      kind: "scholarly",
      citation: "A citation.",
    });
    await db().insert(ritualTranslations).values({
      ritualVersionId: draft.value.versionId,
      locale: "en",
      name: "Machine name",
      description: "Machine description",
      method: "machine",
    });
    await markReviewed(reviewer, draft.value.versionId, "r2");

    expect(
      await publishRitualVersion(superAdmin, draft.value.versionId, "r3"),
    ).toEqual({ ok: false, error: "NO_HUMAN_REVIEWED_TRANSLATION" });
  });

  it("records who published, and when", async () => {
    const versionId = await readyToPublish();
    await publishRitualVersion(superAdmin, versionId, "r_publish");

    const [row] = await db()
      .select()
      .from(ritualVersions)
      .where(eq(ritualVersions.id, versionId));

    expect(row?.status).toBe("published");
    expect(row?.publishedByUserId).toBe(adminUserId);
    expect(row?.publishedAt).toBeInstanceOf(Date);
    expect(row?.reviewedByUserId).toBe(staffUserId);
  });

  it("will not publish the same version twice", async () => {
    const versionId = await readyToPublish();
    await publishRitualVersion(superAdmin, versionId, "r1");

    expect(await publishRitualVersion(superAdmin, versionId, "r2")).toEqual({
      ok: false,
      error: "ALREADY_PUBLISHED",
    });
  });
});

describe("published versions are immutable", () => {
  it("cannot be sent back for review", async () => {
    // A family adopted this exact wording. Editing it underneath them would
    // change what their memorial offers without anyone asking.
    const versionId = await readyToPublish();
    await publishRitualVersion(superAdmin, versionId, "r1");

    expect(await markReviewed(reviewer, versionId, "r2")).toEqual({
      ok: false,
      error: "CANNOT_EDIT_PUBLISHED",
    });
  });

  it("are corrected by adding a new version", async () => {
    const versionId = await readyToPublish();
    await publishRitualVersion(superAdmin, versionId, "r1");

    const correction = await createDraftVersion(
      reviewer,
      { definitionId, appliesToReligionId: religionId },
      "r2",
    );

    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    expect(correction.value.versionId).not.toBe(versionId);
    expect(correction.value.version).toBe(2);

    // The published one is untouched and still adoptable.
    const [original] = await db()
      .select()
      .from(ritualVersions)
      .where(eq(ritualVersions.id, versionId));
    expect(original?.status).toBe("published");
  });
});

describe("what a family may adopt", () => {
  it("is only a published version", async () => {
    const versionId = await readyToPublish();
    const defId = definitionId;

    // Still in review: not adoptable.
    expect(await adoptableVersions(defId)).toHaveLength(0);

    await publishRitualVersion(superAdmin, versionId, "r1");
    expect(await adoptableVersions(defId)).toHaveLength(1);
  });

  it("excludes a retired version", async () => {
    const versionId = await readyToPublish();
    const defId = definitionId;
    await publishRitualVersion(superAdmin, versionId, "r1");

    await retireRitualVersion(
      superAdmin,
      versionId,
      "A reviewer found the description misleading.",
      "r2",
    );

    expect(await adoptableVersions(defId)).toHaveLength(0);
  });

  it("keeps a retired version and its reason on record", async () => {
    // Doc 05 section 5: owners who adopted it are told, and choose a
    // replacement themselves rather than having one swapped in.
    const versionId = await readyToPublish();
    await publishRitualVersion(superAdmin, versionId, "r1");
    await retireRitualVersion(superAdmin, versionId, "Superseded.", "r2");

    const [row] = await db()
      .select()
      .from(ritualVersions)
      .where(eq(ritualVersions.id, versionId));

    expect(row?.status).toBe("retired");
    expect(row?.retirementReason).toBe("Superseded.");
    expect(row?.retiredAt).toBeInstanceOf(Date);
  });

  it("cannot be published again once retired", async () => {
    const versionId = await readyToPublish();
    await retireRitualVersion(superAdmin, versionId, "Withdrawn.", "r1");

    expect(await publishRitualVersion(superAdmin, versionId, "r2")).toEqual({
      ok: false,
      error: "RETIRED",
    });
  });

  it("is refused to a reviewer trying to retire", async () => {
    const versionId = await readyToPublish();
    await publishRitualVersion(superAdmin, versionId, "r1");

    expect(await retireRitualVersion(reviewer, versionId, "No.", "r2")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });
});

describe("reader-facing translations", () => {
  it("appear only after the version is published", async () => {
    const versionId = await readyToPublish();

    expect(await publishedTranslation(versionId, "en")).toBeNull();

    await publishRitualVersion(superAdmin, versionId, "r1");
    const rendered = await publishedTranslation(versionId, "en");

    expect(rendered?.name).toBe("A way of remembering");
    expect(rendered?.method).toBe("human");
  });

  it("leave a machine draft unpublished even when the version goes live", async () => {
    const defId = await makeDefinition();
    const draft = await createDraftVersion(
      reviewer,
      { definitionId: defId, appliesToReligionId: religionId },
      "r1",
    );
    if (!draft.ok) throw new Error("draft failed");

    await db().insert(ritualSources).values({
      ritualVersionId: draft.value.versionId,
      kind: "scholarly",
      citation: "A citation.",
    });
    await db().insert(ritualTranslations).values([
      {
        ritualVersionId: draft.value.versionId,
        locale: "en",
        name: "Reviewed English",
        description: "Reviewed.",
        method: "human",
      },
      {
        ritualVersionId: draft.value.versionId,
        locale: "fr",
        name: "Traduction automatique",
        description: "Non revue.",
        method: "machine",
      },
    ]);
    await markReviewed(reviewer, draft.value.versionId, "r2");
    await publishRitualVersion(superAdmin, draft.value.versionId, "r3");

    expect(await publishedTranslation(draft.value.versionId, "en")).not.toBeNull();
    // The French machine draft is not shown to anyone.
    expect(await publishedTranslation(draft.value.versionId, "fr")).toBeNull();
  });

  it("return nothing for a language with no reviewed translation", async () => {
    const versionId = await readyToPublish();
    await publishRitualVersion(superAdmin, versionId, "r1");

    expect(await publishedTranslation(versionId, "ja")).toBeNull();
  });
});
