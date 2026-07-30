import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  memorialMembers,
  memorialRitualSettings,
  memorials,
  outboxEvents,
  religions,
  ritualDefinitions,
  ritualSources,
  ritualTranslations,
  ritualVersions,
  users,
} from "@/db/schema";
import { seedReligions } from "@/db/seed/religions";
import { createMemorial } from "@/modules/memorials/service";
import {
  createDraftVersion,
  markReviewed,
  publishRitualVersion,
  retireRitualVersion,
} from "@/modules/religion/catalog";
import {
  enabledRituals,
  ritualSettingFor,
  setRitualSetting,
} from "@/modules/religion/memorial-settings";
import type { Actor, MemorialRole } from "@/modules/permissions/types";

const createdUserIds: string[] = [];
const createdDefinitionIds: string[] = [];

let staff: Actor;
let admin: Actor;
let religionId: string;

beforeAll(async () => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
  await seedReligions();

  const [staffRow] = await db()
    .insert(users)
    .values({ displayName: "Catalogue reviewer" })
    .returning({ id: users.id });
  const [adminRow] = await db()
    .insert(users)
    .values({ displayName: "Catalogue publisher" })
    .returning({ id: users.id });
  if (!staffRow || !adminRow) throw new Error("user insert returned no row");

  createdUserIds.push(staffRow.id, adminRow.id);
  staff = { userId: staffRow.id, platformRole: "reviewer" };
  admin = { userId: adminRow.id, platformRole: "super_admin" };

  const [religion] = await db()
    .select({ id: religions.id })
    .from(religions)
    .where(eq(religions.slug, "secular"));
  if (!religion) throw new Error("expected the seeded classification");
  religionId = religion.id;
});

afterEach(async () => {
  const userIds = createdUserIds.filter(
    (id) => id !== staff.userId && id !== admin.userId,
  );
  if (userIds.length === 0) return;

  const owned = await db()
    .select({ id: memorials.id, personId: memorials.deceasedPersonId })
    .from(memorials)
    .where(inArray(memorials.ownerUserId, userIds));
  const memorialIds = owned.map((row) => row.id);

  if (memorialIds.length > 0) {
    await db()
      .delete(memorialRitualSettings)
      .where(inArray(memorialRitualSettings.memorialId, memorialIds));
    await db().delete(auditLogs).where(inArray(auditLogs.resourceId, memorialIds));
    await db()
      .delete(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, memorialIds));
    await db().delete(memorials).where(inArray(memorials.id, memorialIds));
    await db()
      .delete(deceasedPeople)
      .where(inArray(deceasedPeople.id, owned.map((row) => row.personId)));
  }

  await db().delete(users).where(inArray(users.id, userIds));
  createdUserIds.splice(0, createdUserIds.length, staff.userId ?? "", admin.userId ?? "");
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
        .delete(memorialRitualSettings)
        .where(inArray(memorialRitualSettings.ritualVersionId, versionIds));
      await db().delete(auditLogs).where(inArray(auditLogs.resourceId, versionIds));
    }
    await db()
      .delete(ritualDefinitions)
      .where(inArray(ritualDefinitions.id, createdDefinitionIds));
  }
  await db().delete(users).where(inArray(users.id, createdUserIds));
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

async function makeMemorial(owner: Actor): Promise<string> {
  const result = await createMemorial(
    owner,
    {
      relationship: "spouse",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");
  return result.value.memorialId;
}

/** A published revision, with the options the reviewed guidance permits. */
async function makePublishedVersion(
  options: {
    allowAnonymous?: boolean;
    allowMessage?: boolean;
    suggestPreReview?: boolean;
  } = {},
): Promise<{ versionId: string; definitionId: string }> {
  const [definition] = await db()
    .insert(ritualDefinitions)
    .values({
      slug: `settings-ritual-${randomUUID()}`,
      actionType: "offering",
      adminLabel: "Test ritual",
    })
    .returning({ id: ritualDefinitions.id });
  if (!definition) throw new Error("definition insert returned no row");
  createdDefinitionIds.push(definition.id);

  const draft = await createDraftVersion(
    staff,
    {
      definitionId: definition.id,
      appliesToReligionId: religionId,
      allowAnonymous: options.allowAnonymous ?? true,
      allowMessage: options.allowMessage ?? true,
      suggestPreReview: options.suggestPreReview ?? true,
    },
    "req_draft",
  );
  if (!draft.ok) throw new Error(`draft failed: ${draft.error}`);

  await db().insert(ritualSources).values({
    ritualVersionId: draft.value.versionId,
    kind: "community_adviser",
    citation: "A reviewed citation from a named adviser.",
    adviserName: "Test adviser",
  });
  await db().insert(ritualTranslations).values({
    ritualVersionId: draft.value.versionId,
    locale: "en",
    name: "Test ritual",
    description: "Reviewed description.",
    method: "human",
  });
  await markReviewed(staff, draft.value.versionId, "req_review");
  const published = await publishRitualVersion(admin, draft.value.versionId, "req_pub");
  if (!published.ok) throw new Error(`publish failed: ${published.error}`);

  return { versionId: draft.value.versionId, definitionId: definition.id };
}

async function addMember(
  memorialId: string,
  actor: Actor,
  role: MemorialRole,
): Promise<void> {
  await db().insert(memorialMembers).values({
    memorialId,
    userId: actor.userId ?? "",
    role,
    acceptedAt: new Date(),
  });
}

describe("nothing is offered until the family says so", () => {
  it("starts with no ritual enabled", async () => {
    // Doc 05 section 9: selecting a religion turns nothing on. A brand new
    // memorial offers visitors nothing at all.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    await makePublishedVersion();

    expect(await enabledRituals(memorialId)).toHaveLength(0);
  });

  it("refuses to enable without an explicit confirmation", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    expect(
      await setRitualSetting(owner, memorialId, versionId, { enabled: true }, "r1"),
    ).toEqual({ ok: false, error: "FAMILY_CONFIRMATION_REQUIRED" });

    expect(await enabledRituals(memorialId)).toHaveLength(0);
  });

  it("enables once the family confirms", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    const result = await setRitualSetting(
      owner,
      memorialId,
      versionId,
      { enabled: true, familyConfirmed: true },
      "r1",
    );

    expect(result.ok).toBe(true);
    const enabled = await enabledRituals(memorialId);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.ritualVersionId).toBe(versionId);
  });

  it("records who confirmed and when", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      { enabled: true, familyConfirmed: true },
      "r1",
    );

    const [row] = await db()
      .select()
      .from(memorialRitualSettings)
      .where(eq(memorialRitualSettings.ritualVersionId, versionId));

    expect(row?.confirmedByUserId).toBe(owner.userId);
    expect(row?.familyConfirmedAt).toBeInstanceOf(Date);
  });

  it("stops offering it when the family turns it off", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      { enabled: true, familyConfirmed: true },
      "r1",
    );
    await setRitualSetting(owner, memorialId, versionId, { enabled: false }, "r2");

    expect(await enabledRituals(memorialId)).toHaveLength(0);
    // The row stays, so a later re-enable is a change rather than a new record.
    expect(await ritualSettingFor(memorialId, versionId)).not.toBeNull();
  });
});

describe("who may configure", () => {
  it("is the owner alone", async () => {
    // Doc 06 section 3. Deciding how visitors may mourn is not the same job as
    // helping write a biography.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    for (const role of ["admin", "editor", "reviewer", "invited_visitor"] as const) {
      const member = await makeActor();
      await addMember(memorialId, member, role);

      expect(
        await setRitualSetting(
          member,
          memorialId,
          versionId,
          { enabled: true, familyConfirmed: true },
          "r1",
        ),
      ).toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });
    }

    expect(await enabledRituals(memorialId)).toHaveLength(0);
  });

  it("tells a stranger the memorial does not exist", async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    expect(
      await setRitualSetting(
        stranger,
        memorialId,
        versionId,
        { enabled: true, familyConfirmed: true },
        "r1",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });

  it("refuses an anonymous caller", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    expect(
      await setRitualSetting(
        { userId: null, platformRole: "super_admin" },
        memorialId,
        versionId,
        { enabled: true, familyConfirmed: true },
        "r1",
      ),
    ).toEqual({ ok: false, error: "AUTH_REQUIRED" });
  });
});

describe("which revisions may be adopted", () => {
  it("refuses a draft", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    const [definition] = await db()
      .insert(ritualDefinitions)
      .values({
        slug: `draft-only-${randomUUID()}`,
        actionType: "gesture",
        adminLabel: "Unreviewed",
      })
      .returning({ id: ritualDefinitions.id });
    if (!definition) throw new Error("definition insert returned no row");
    createdDefinitionIds.push(definition.id);

    const draft = await createDraftVersion(
      staff,
      { definitionId: definition.id },
      "r1",
    );
    if (!draft.ok) throw new Error("draft failed");

    expect(
      await setRitualSetting(
        owner,
        memorialId,
        draft.value.versionId,
        { enabled: true, familyConfirmed: true },
        "r2",
      ),
    ).toEqual({ ok: false, error: "RITUAL_VERSION_NOT_PUBLISHED" });
  });

  it("refuses a newly adopted retired revision", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();
    await retireRitualVersion(admin, versionId, "Withdrawn.", "r1");

    expect(
      await setRitualSetting(
        owner,
        memorialId,
        versionId,
        { enabled: true, familyConfirmed: true },
        "r2",
      ),
    ).toEqual({ ok: false, error: "RITUAL_VERSION_NOT_PUBLISHED" });
  });

  it("lets a family who already adopted a revision keep changing its settings", async () => {
    // Doc 05 section 5: the platform notifies and lets the owner choose. It does
    // not lock them out of their own memorial when a revision is withdrawn.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      { enabled: true, familyConfirmed: true },
      "r1",
    );
    await retireRitualVersion(admin, versionId, "Withdrawn.", "r2");

    // Turning it off is still possible after retirement.
    expect(
      (await setRitualSetting(owner, memorialId, versionId, { enabled: false }, "r3"))
        .ok,
    ).toBe(true);
  });

  it("refuses a version that does not exist", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await setRitualSetting(
        owner,
        memorialId,
        randomUUID(),
        { enabled: true, familyConfirmed: true },
        "r1",
      ),
    ).toEqual({ ok: false, error: "RITUAL_VERSION_NOT_FOUND" });
  });
});

describe("a catalogue change does not reach an existing memorial", () => {
  it("keeps the memorial on the revision the family agreed to", async () => {
    // The central guarantee of doc 05 section 5. A newer revision is published;
    // this memorial keeps offering what the family accepted.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId, definitionId } = await makePublishedVersion();

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      { enabled: true, familyConfirmed: true },
      "r1",
    );

    // A second revision of the same action is published.
    const second = await createDraftVersion(
      staff,
      { definitionId, appliesToReligionId: religionId },
      "r2",
    );
    if (!second.ok) throw new Error("draft failed");
    await db().insert(ritualSources).values({
      ritualVersionId: second.value.versionId,
      kind: "scholarly",
      citation: "A revised citation.",
    });
    await db().insert(ritualTranslations).values({
      ritualVersionId: second.value.versionId,
      locale: "en",
      name: "Revised ritual",
      description: "Revised description.",
      method: "human",
    });
    await markReviewed(staff, second.value.versionId, "r3");
    await publishRitualVersion(admin, second.value.versionId, "r4");

    const enabled = await enabledRituals(memorialId);
    expect(enabled).toHaveLength(1);
    // Still the original revision, not the new one.
    expect(enabled[0]?.ritualVersionId).toBe(versionId);
    expect(enabled[0]?.ritualVersionId).not.toBe(second.value.versionId);
  });

  it("moves only when the family chooses the newer revision", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId, definitionId } = await makePublishedVersion();

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      { enabled: true, familyConfirmed: true },
      "r1",
    );

    const second = await createDraftVersion(
      staff,
      { definitionId, appliesToReligionId: religionId },
      "r2",
    );
    if (!second.ok) throw new Error("draft failed");
    await db().insert(ritualSources).values({
      ritualVersionId: second.value.versionId,
      kind: "scholarly",
      citation: "A revised citation.",
    });
    await db().insert(ritualTranslations).values({
      ritualVersionId: second.value.versionId,
      locale: "en",
      name: "Revised",
      description: "Revised.",
      method: "human",
    });
    await markReviewed(staff, second.value.versionId, "r3");
    await publishRitualVersion(admin, second.value.versionId, "r4");

    await setRitualSetting(
      owner,
      memorialId,
      second.value.versionId,
      { enabled: true, familyConfirmed: true },
      "r5",
    );

    const enabled = await enabledRituals(memorialId);
    // One action, one revision: adopting the newer one replaces the older.
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.ritualVersionId).toBe(second.value.versionId);
  });
});

describe("the reviewed revision sets the ceiling", () => {
  it("lets a family be more restrictive than the guidance", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion({
      allowAnonymous: true,
      allowMessage: true,
    });

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      {
        enabled: true,
        familyConfirmed: true,
        allowAnonymous: false,
        allowMessage: false,
      },
      "r1",
    );

    const [setting] = await enabledRituals(memorialId);
    expect(setting?.allowAnonymous).toBe(false);
    expect(setting?.allowMessage).toBe(false);
  });

  it("does not let a family be more permissive than the guidance", async () => {
    // If reviewed guidance says a practice should not be anonymous, a checkbox
    // does not overrule it.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion({
      allowAnonymous: false,
      allowMessage: false,
    });

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      {
        enabled: true,
        familyConfirmed: true,
        allowAnonymous: true,
        allowMessage: true,
      },
      "r1",
    );

    const [setting] = await enabledRituals(memorialId);
    expect(setting?.allowAnonymous).toBe(false);
    expect(setting?.allowMessage).toBe(false);
  });

  it("follows the revision's review suggestion by default", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion({ suggestPreReview: true });

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      { enabled: true, familyConfirmed: true },
      "r1",
    );

    const [setting] = await enabledRituals(memorialId);
    expect(setting?.moderationMode).toBe("pre_review");
  });

  it("lets the family show messages straight away if they prefer", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion({ suggestPreReview: true });

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      { enabled: true, familyConfirmed: true, moderationMode: "post_review" },
      "r1",
    );

    const [setting] = await enabledRituals(memorialId);
    expect(setting?.moderationMode).toBe("post_review");
  });

  it("keeps the family's own wording for the action", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const { versionId } = await makePublishedVersion();

    await setRitualSetting(
      owner,
      memorialId,
      versionId,
      {
        enabled: true,
        familyConfirmed: true,
        displayNameOverride: "Light a lamp for Mum",
      },
      "r1",
    );

    const [setting] = await enabledRituals(memorialId);
    expect(setting?.displayNameOverride).toBe("Light a lamp for Mum");
  });
});
