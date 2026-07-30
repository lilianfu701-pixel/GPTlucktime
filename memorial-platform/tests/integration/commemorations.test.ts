import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  blockedUsers,
  commemorationMessages,
  commemorations,
  deceasedPeople,
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
import {
  createCommemoration,
  visibleCommemorationCount,
  visibleMessages,
} from "@/modules/commemorations/service";
import { PER_MEMORIAL_LIMIT } from "@/modules/commemorations/rate-limit";
import { changePrivacy } from "@/modules/memorials/privacy";
import { createMemorial } from "@/modules/memorials/service";
import {
  createDraftVersion,
  markReviewed,
  publishRitualVersion,
} from "@/modules/religion/catalog";
import { setRitualSetting } from "@/modules/religion/memorial-settings";
import type { Actor } from "@/modules/permissions/types";

const anonymous: Actor = { userId: null, platformRole: "user" };
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
    const acts = await db()
      .select({ id: commemorations.id })
      .from(commemorations)
      .where(inArray(commemorations.memorialId, memorialIds));
    if (acts.length > 0) {
      await db()
        .delete(commemorationMessages)
        .where(
          inArray(commemorationMessages.commemorationId, acts.map((row) => row.id)),
        );
    }
    await db()
      .delete(commemorations)
      .where(inArray(commemorations.memorialId, memorialIds));
    await db()
      .delete(blockedUsers)
      .where(inArray(blockedUsers.memorialId, memorialIds));
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
    .values({ displayName: `Visitor ${randomUUID().slice(0, 8)}` })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no row");
  createdUserIds.push(row.id);
  return { userId: row.id, platformRole: "user" };
}

async function makePublishedVersion(options: {
  allowAnonymous?: boolean;
  allowMessage?: boolean;
  suggestPreReview?: boolean;
}): Promise<string> {
  const [definition] = await db()
    .insert(ritualDefinitions)
    .values({
      slug: `commem-ritual-${randomUUID()}`,
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
      suggestPreReview: options.suggestPreReview ?? false,
    },
    "req_draft",
  );
  if (!draft.ok) throw new Error("draft failed");

  await db().insert(ritualSources).values({
    ritualVersionId: draft.value.versionId,
    kind: "community_adviser",
    citation: "A reviewed citation.",
  });
  await db().insert(ritualTranslations).values({
    ritualVersionId: draft.value.versionId,
    locale: "en",
    name: "Lay flowers",
    description: "Reviewed description.",
    method: "human",
  });
  await markReviewed(staff, draft.value.versionId, "req_review");
  await publishRitualVersion(admin, draft.value.versionId, "req_pub");

  return draft.value.versionId;
}

/** A published memorial with one ritual switched on by the family. */
async function makeMemorialOfferingRitual(
  options: {
    allowAnonymous?: boolean;
    allowMessage?: boolean;
    moderationMode?: "pre_review" | "post_review";
    visibility?: "public" | "unlisted" | "invite_only";
  } = {},
): Promise<{ owner: Actor; memorialId: string; versionId: string }> {
  const owner = await makeActor();
  const result = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
      visibility: options.visibility ?? "public",
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");

  await db()
    .update(memorials)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(memorials.id, result.value.memorialId));

  const versionId = await makePublishedVersion({
    allowAnonymous: options.allowAnonymous ?? true,
    allowMessage: options.allowMessage ?? true,
    suggestPreReview: options.moderationMode === "pre_review",
  });

  const setting = await setRitualSetting(
    owner,
    result.value.memorialId,
    versionId,
    {
      enabled: true,
      familyConfirmed: true,
      allowAnonymous: options.allowAnonymous ?? true,
      allowMessage: options.allowMessage ?? true,
      moderationMode: options.moderationMode ?? "post_review",
    },
    "req_enable",
  );
  if (!setting.ok) throw new Error(`enable failed: ${setting.error}`);

  return { owner, memorialId: result.value.memorialId, versionId };
}

describe("what the family permitted", () => {
  it("records an act the family enabled", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    const result = await createCommemoration(
      visitor,
      { memorialId, ritualVersionId: versionId, locale: "en" },
      randomUUID(),
      {},
      "req_1",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("visible");
    expect(result.value.created).toBe(true);
    expect(await visibleCommemorationCount(memorialId)).toBe(1);
  });

  it("refuses a ritual the family never switched on", async () => {
    // Publishing a revision in the catalogue does not put it on anyone's page.
    const { memorialId } = await makeMemorialOfferingRitual();
    const otherVersionId = await makePublishedVersion({});
    const visitor = await makeActor();

    expect(
      await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: otherVersionId, locale: "en" },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "RITUAL_NOT_ENABLED" });
  });

  it("refuses a ritual the family switched off again", async () => {
    const { owner, memorialId, versionId } = await makeMemorialOfferingRitual();
    await setRitualSetting(owner, memorialId, versionId, { enabled: false }, "r1");

    const visitor = await makeActor();
    expect(
      await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "RITUAL_NOT_ENABLED" });
  });
});

describe("access", () => {
  it("hides an invite-only memorial from a stranger", async () => {
    // The same answer as a memorial that does not exist.
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      visibility: "invite_only",
    });
    const stranger = await makeActor();

    expect(
      await createCommemoration(
        stranger,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });

  it("stops accepting acts the moment a memorial turns private", async () => {
    const { owner, memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    expect(
      (
        await createCommemoration(
          visitor,
          { memorialId, ritualVersionId: versionId, locale: "en" },
          randomUUID(),
          {},
          "r1",
        )
      ).ok,
    ).toBe(true);

    await changePrivacy(owner, memorialId, { visibility: "invite_only" }, "r2");

    expect(
      await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        "r3",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });

  it("refuses a memorial that does not exist", async () => {
    const versionId = await makePublishedVersion({});
    const visitor = await makeActor();

    expect(
      await createCommemoration(
        visitor,
        { memorialId: randomUUID(), ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });
});

describe("signing in", () => {
  it("lets a visitor act without an account when the family allows it", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      allowAnonymous: true,
    });

    const result = await createCommemoration(
      anonymous,
      { memorialId, ritualVersionId: versionId, locale: "en" },
      randomUUID(),
      { requestIpHash: "a".repeat(64) },
      "req_1",
    );

    expect(result.ok).toBe(true);

    const [row] = await db()
      .select()
      .from(commemorations)
      .where(eq(commemorations.memorialId, memorialId));
    expect(row?.actorUserId).toBeNull();
    // Acting without an account is itself anonymous, whatever the request said.
    expect(row?.anonymous).toBe(true);
  });

  it("requires an account when the family does not allow anonymity", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      allowAnonymous: false,
    });

    expect(
      await createCommemoration(
        anonymous,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "AUTH_REQUIRED" });
  });

  it("refuses a signed-in visitor asking to be unnamed where that is not allowed", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      allowAnonymous: false,
    });
    const visitor = await makeActor();

    expect(
      await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, locale: "en", anonymous: true },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "ANONYMOUS_NOT_ALLOWED" });
  });

  it("honours a signed-in visitor who asks not to be named", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      allowAnonymous: true,
    });
    const visitor = await makeActor();

    await createCommemoration(
      visitor,
      { memorialId, ritualVersionId: versionId, locale: "en", anonymous: true },
      randomUUID(),
      {},
      "req_1",
    );

    const [row] = await db()
      .select()
      .from(commemorations)
      .where(eq(commemorations.memorialId, memorialId));

    expect(row?.anonymous).toBe(true);
    // The account is still recorded, so the family can act on abuse.
    expect(row?.actorUserId).toBe(visitor.userId);
  });
});

describe("messages", () => {
  it("appears at once when the family chose to show messages straight away", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      allowMessage: true,
      moderationMode: "post_review",
    });
    const visitor = await makeActor();

    const result = await createCommemoration(
      visitor,
      {
        memorialId,
        ritualVersionId: versionId,
        message: "He taught me to ride a bicycle.",
        locale: "en",
      },
      randomUUID(),
      {},
      "req_1",
    );

    expect(result.ok && result.value.status).toBe("visible");
    const messages = await visibleMessages(memorialId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("He taught me to ride a bicycle.");
  });

  it("waits for the family when they chose to read messages first", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      allowMessage: true,
      moderationMode: "pre_review",
    });
    const visitor = await makeActor();

    const result = await createCommemoration(
      visitor,
      {
        memorialId,
        ritualVersionId: versionId,
        message: "Something the family should read first.",
        locale: "en",
      },
      randomUUID(),
      {},
      "req_1",
    );

    expect(result.ok && result.value.status).toBe("pending_review");
    expect(await visibleMessages(memorialId)).toHaveLength(0);
  });

  it("refuses a message where the family did not allow one", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      allowMessage: false,
    });
    const visitor = await makeActor();

    expect(
      await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, message: "Hello", locale: "en" },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "MESSAGE_NOT_ALLOWED" });
  });

  it("still accepts the act itself where messages are not allowed", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      allowMessage: false,
    });
    const visitor = await makeActor();

    expect(
      (
        await createCommemoration(
          visitor,
          { memorialId, ritualVersionId: versionId, locale: "en" },
          randomUUID(),
          {},
          "req_1",
        )
      ).ok,
    ).toBe(true);
  });

  it("refuses a message that is only whitespace", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    expect(
      await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, message: "   ", locale: "en" },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "EMPTY_MESSAGE" });
  });
});

describe("blocked visitors", () => {
  it("cannot leave anything further", async () => {
    const { owner, memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    await db().insert(blockedUsers).values({
      memorialId,
      blockedUserId: visitor.userId ?? "",
      blockedByUserId: owner.userId,
      reason: "Repeated unkind messages.",
    });

    expect(
      await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        "req_1",
      ),
    ).toEqual({ ok: false, error: "BLOCKED" });
  });

  it("can act again once the family lifts the block", async () => {
    const { owner, memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    await db().insert(blockedUsers).values({
      memorialId,
      blockedUserId: visitor.userId ?? "",
      blockedByUserId: owner.userId,
    });
    await db()
      .update(blockedUsers)
      .set({ liftedAt: new Date() })
      .where(eq(blockedUsers.blockedUserId, visitor.userId ?? ""));

    expect(
      (
        await createCommemoration(
          visitor,
          { memorialId, ritualVersionId: versionId, locale: "en" },
          randomUUID(),
          {},
          "req_1",
        )
      ).ok,
    ).toBe(true);
  });

  it("is scoped to one memorial", async () => {
    // Behaving badly on one page has not done anything to another family.
    const first = await makeMemorialOfferingRitual();
    const second = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    await db().insert(blockedUsers).values({
      memorialId: first.memorialId,
      blockedUserId: visitor.userId ?? "",
      blockedByUserId: first.owner.userId,
    });

    expect(
      (
        await createCommemoration(
          visitor,
          { memorialId: second.memorialId, ritualVersionId: second.versionId, locale: "en" },
          randomUUID(),
          {},
          "req_1",
        )
      ).ok,
    ).toBe(true);
  });
});

describe("idempotency", () => {
  it("returns the same record when a request is retried", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();
    const key = randomUUID();
    const input = {
      memorialId,
      ritualVersionId: versionId,
      message: "In memory.",
      locale: "en",
    };

    const first = await createCommemoration(visitor, input, key, {}, "r1");
    const second = await createCommemoration(visitor, input, key, {}, "r2");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(first.value.created).toBe(true);
    expect(second.value.created).toBe(false);

    expect(await visibleCommemorationCount(memorialId)).toBe(1);
  });

  it("records one act when retries arrive at the same moment", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createCommemoration(
          visitor,
          { memorialId, ritualVersionId: versionId, locale: "en" },
          key,
          {},
          `r${index}`,
        ),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const ids = new Set(
      results.flatMap((result) => (result.ok ? [result.value.id] : [])),
    );
    expect(ids.size).toBe(1);
    expect(await visibleCommemorationCount(memorialId)).toBe(1);
  });

  it("reports a conflict when the same key carries a different act", async () => {
    // Doc 04 section 10. Silently returning the first record would tell a client
    // its second, different request succeeded.
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();
    const key = randomUUID();

    await createCommemoration(
      visitor,
      { memorialId, ritualVersionId: versionId, message: "First words.", locale: "en" },
      key,
      {},
      "r1",
    );

    expect(
      await createCommemoration(
        visitor,
        {
          memorialId,
          ritualVersionId: versionId,
          message: "Different words.",
          locale: "en",
        },
        key,
        {},
        "r2",
      ),
    ).toEqual({ ok: false, error: "IDEMPOTENCY_CONFLICT" });
  });

  it("lets the same key be reused on a different memorial", async () => {
    const first = await makeMemorialOfferingRitual();
    const second = await makeMemorialOfferingRitual();
    const visitor = await makeActor();
    const key = "shared-key";

    const a = await createCommemoration(
      visitor,
      { memorialId: first.memorialId, ritualVersionId: first.versionId, locale: "en" },
      key,
      {},
      "r1",
    );
    const b = await createCommemoration(
      visitor,
      { memorialId: second.memorialId, ritualVersionId: second.versionId, locale: "en" },
      key,
      {},
      "r2",
    );

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.id).not.toBe(b.value.id);
  });
});

describe("rate limits", () => {
  it("stops one visitor flooding a single memorial", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    for (let index = 0; index < PER_MEMORIAL_LIMIT.max; index += 1) {
      const result = await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        `r${index}`,
      );
      expect(result.ok).toBe(true);
    }

    expect(
      await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        "r_over",
      ),
    ).toEqual({ ok: false, error: "RATE_LIMITED" });
  });

  it("does not count one visitor's acts against another's allowance", async () => {
    // A large family sharing news of a death produces a burst of genuine visits.
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const busy = await makeActor();
    const newcomer = await makeActor();

    for (let index = 0; index < PER_MEMORIAL_LIMIT.max; index += 1) {
      await createCommemoration(
        busy,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        randomUUID(),
        {},
        `r${index}`,
      );
    }

    expect(
      (
        await createCommemoration(
          newcomer,
          { memorialId, ritualVersionId: versionId, locale: "en" },
          randomUUID(),
          {},
          "r_new",
        )
      ).ok,
    ).toBe(true);
  });

  it("does not spend the allowance on a retry", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();
    const key = randomUUID();

    for (let index = 0; index < PER_MEMORIAL_LIMIT.max + 5; index += 1) {
      const result = await createCommemoration(
        visitor,
        { memorialId, ritualVersionId: versionId, locale: "en" },
        key,
        {},
        `r${index}`,
      );
      // Idempotency is checked before the limit, so a client retrying after a
      // timeout is never told it is being rate limited.
      expect(result.ok).toBe(true);
    }

    expect(await visibleCommemorationCount(memorialId)).toBe(1);
  });
});

describe("notification", () => {
  it("is queued rather than sent inline", async () => {
    // A mail provider being down must not undo someone's act of remembrance.
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    const result = await createCommemoration(
      visitor,
      { memorialId, ritualVersionId: versionId, locale: "en" },
      randomUUID(),
      {},
      "req_notify",
    );
    expect(result.ok).toBe(true);

    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, memorialId));

    const created = events.filter(
      (event) => event.topic === "commemoration.created",
    );
    expect(created).toHaveLength(1);
    // Still waiting for the worker, and the commemoration is already committed.
    expect(created[0]?.processedAt).toBeNull();
    expect(await visibleCommemorationCount(memorialId)).toBe(1);
  });
});

describe("counts", () => {
  it("exclude a message still waiting for the family", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual({
      moderationMode: "pre_review",
    });
    const visitor = await makeActor();

    await createCommemoration(
      visitor,
      { memorialId, ritualVersionId: versionId, message: "Waiting.", locale: "en" },
      randomUUID(),
      {},
      "r1",
    );

    expect(await visibleCommemorationCount(memorialId)).toBe(0);
  });

  it("exclude a withdrawn act", async () => {
    const { memorialId, versionId } = await makeMemorialOfferingRitual();
    const visitor = await makeActor();

    const result = await createCommemoration(
      visitor,
      { memorialId, ritualVersionId: versionId, locale: "en" },
      randomUUID(),
      {},
      "r1",
    );
    if (!result.ok) throw new Error("create failed");

    await db()
      .update(commemorations)
      .set({ deletedAt: new Date() })
      .where(eq(commemorations.id, result.value.id));

    expect(await visibleCommemorationCount(memorialId)).toBe(0);
  });
});
