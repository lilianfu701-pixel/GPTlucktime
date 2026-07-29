import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  biographies,
  contentTranslations,
  contentVersions,
  deceasedPeople,
  memorialMembers,
  memorials,
  outboxEvents,
  users,
  visitorSubmissions,
} from "@/db/schema";
import {
  moderateSubmission,
  pendingVisitorStories,
  publicVisitorStories,
  publishBiography,
  publishedBiography,
  saveBiography,
  submitVisitorStory,
  versionHistory,
} from "@/modules/memorials/content-service";
import { createMemorial } from "@/modules/memorials/service";
import {
  approveTranslation,
  renderContent,
  saveTranslation,
} from "@/modules/memorials/translation-service";
import type { Actor } from "@/modules/permissions/types";
import type { MemorialRole } from "@/modules/permissions/types";

const createdUserIds: string[] = [];

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
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
    const bios = await db()
      .select({ id: biographies.id })
      .from(biographies)
      .where(inArray(biographies.memorialId, memorialIds));
    if (bios.length > 0) {
      await db()
        .update(biographies)
        .set({ publishedVersionId: null })
        .where(inArray(biographies.memorialId, memorialIds));
      await db()
        .delete(contentVersions)
        .where(inArray(contentVersions.contentId, bios.map((row) => row.id)));
    }
    await db()
      .delete(visitorSubmissions)
      .where(inArray(visitorSubmissions.memorialId, memorialIds));
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
});

afterAll(async () => {
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
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");
  return result.value.memorialId;
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

describe("versioned biographies", () => {
  it("appends a version instead of overwriting the previous one", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    const first = await saveBiography(
      owner,
      memorialId,
      { body: "He taught mathematics for thirty years.", sourceLocale: "en" },
      "req_1",
    );
    if (!first.ok) throw new Error("first save failed");

    const second = await saveBiography(
      owner,
      memorialId,
      { body: "He taught mathematics for thirty-two years.", sourceLocale: "en" },
      "req_2",
    );
    if (!second.ok) throw new Error("second save failed");

    const history = await versionHistory("biography", first.value.biographyId);

    expect(history).toHaveLength(2);
    expect(history[0]?.version).toBe(1);
    // The earlier wording is still exactly as it was written.
    expect(history[0]?.body).toBe("He taught mathematics for thirty years.");
    expect(history[1]?.version).toBe(2);
  });

  it("shows the public nothing until the family publishes", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    await saveBiography(
      owner,
      memorialId,
      { body: "A first draft, not ready.", sourceLocale: "en" },
      "req_1",
    );

    expect(await publishedBiography(memorialId)).toBeNull();
  });

  it("keeps showing the published version while a new draft is being written", async () => {
    // Someone reading the page must not see a half-finished sentence appear.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    await saveBiography(
      owner,
      memorialId,
      { body: "The published account.", sourceLocale: "en" },
      "req_1",
    );
    await publishBiography(owner, memorialId, "req_2");

    await saveBiography(
      owner,
      memorialId,
      { body: "An unfinished revision", sourceLocale: "en" },
      "req_3",
    );

    expect((await publishedBiography(memorialId))?.body).toBe(
      "The published account.",
    );
  });

  it("moves the public pointer when the family publishes again", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    await saveBiography(owner, memorialId, { body: "First.", sourceLocale: "en" }, "r1");
    await publishBiography(owner, memorialId, "r2");
    await saveBiography(owner, memorialId, { body: "Second.", sourceLocale: "en" }, "r3");
    await publishBiography(owner, memorialId, "r4");

    expect((await publishedBiography(memorialId))?.body).toBe("Second.");
  });

  it("refuses to publish when nothing has been written", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(await publishBiography(owner, memorialId, "req_1")).toEqual({
      ok: false,
      error: "CONTENT_NOT_FOUND",
    });
  });

  it("refuses an empty body", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await saveBiography(owner, memorialId, { body: "   ", sourceLocale: "en" }, "r1"),
    ).toEqual({ ok: false, error: "EMPTY_BODY" });
  });

  it("records who wrote each version", async () => {
    const owner = await makeActor();
    const editor = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, editor, "editor");

    const saved = await saveBiography(
      editor,
      memorialId,
      { body: "Written by the editor.", sourceLocale: "en" },
      "req_1",
    );
    if (!saved.ok) throw new Error("save failed");

    const [version] = await db()
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.contentId, saved.value.biographyId));

    expect(version?.authorUserId).toBe(editor.userId);
  });
});

describe("who may write and publish", () => {
  it("lets an editor write and publish, per doc 06 section 3", async () => {
    // Writing a family's account of a life and publishing it are the same job.
    const owner = await makeActor();
    const editor = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, editor, "editor");

    expect(
      (await saveBiography(editor, memorialId, { body: "Text.", sourceLocale: "en" }, "r1"))
        .ok,
    ).toBe(true);
    expect((await publishBiography(editor, memorialId, "r2")).ok).toBe(true);
  });

  it("lets an administrator write and publish", async () => {
    const owner = await makeActor();
    const admin = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, admin, "admin");

    expect(
      (await saveBiography(admin, memorialId, { body: "Text.", sourceLocale: "en" }, "r1"))
        .ok,
    ).toBe(true);
    expect((await publishBiography(admin, memorialId, "r2")).ok).toBe(true);
  });

  it("does not let a reviewer rewrite the life story", async () => {
    // A reviewer screens what visitors send. They do not author the family's
    // account of a life.
    const owner = await makeActor();
    const reviewer = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, reviewer, "reviewer");

    expect(
      await saveBiography(reviewer, memorialId, { body: "No.", sourceLocale: "en" }, "r1"),
    ).toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });
  });

  it("does not let an invited visitor write", async () => {
    const owner = await makeActor();
    const guest = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, guest, "invited_visitor");

    expect(
      await saveBiography(guest, memorialId, { body: "No.", sourceLocale: "en" }, "r1"),
    ).toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });
  });

  it("tells a stranger the memorial does not exist", async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await saveBiography(stranger, memorialId, { body: "No.", sourceLocale: "en" }, "r1"),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });

  it("refuses an anonymous writer", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await saveBiography(
        { userId: null, platformRole: "user" },
        memorialId,
        { body: "No.", sourceLocale: "en" },
        "r1",
      ),
    ).toEqual({ ok: false, error: "AUTH_REQUIRED" });
  });
});

describe("visitor submissions", () => {
  it("waits for the family before appearing", async () => {
    const owner = await makeActor();
    const visitor = await makeActor();
    const memorialId = await makeMemorial(owner);

    const submitted = await submitVisitorStory(
      visitor,
      memorialId,
      { body: "He helped me move house in the rain.", sourceLocale: "en" },
      "req_1",
    );
    expect(submitted.ok).toBe(true);

    expect(await publicVisitorStories(memorialId)).toHaveLength(0);
  });

  it("appears once the family accepts it", async () => {
    const owner = await makeActor();
    const visitor = await makeActor();
    const memorialId = await makeMemorial(owner);

    const submitted = await submitVisitorStory(
      visitor,
      memorialId,
      { body: "A kind memory.", sourceLocale: "en" },
      "req_1",
    );
    if (!submitted.ok) throw new Error("submit failed");

    await moderateSubmission(owner, submitted.value.submissionId, "published", "r2");

    const stories = await publicVisitorStories(memorialId);
    expect(stories).toHaveLength(1);
    expect(stories[0]?.body).toBe("A kind memory.");
  });

  it("never surfaces a rejected submission", async () => {
    // The row is kept for the family's record, but no public query returns it.
    const owner = await makeActor();
    const visitor = await makeActor();
    const memorialId = await makeMemorial(owner);

    const submitted = await submitVisitorStory(
      visitor,
      memorialId,
      { body: "Something the family did not want.", sourceLocale: "en" },
      "req_1",
    );
    if (!submitted.ok) throw new Error("submit failed");

    await moderateSubmission(owner, submitted.value.submissionId, "rejected", "r2");

    expect(await publicVisitorStories(memorialId)).toHaveLength(0);

    const [row] = await db()
      .select()
      .from(visitorSubmissions)
      .where(eq(visitorSubmissions.id, submitted.value.submissionId));
    expect(row?.status).toBe("rejected");
    expect(row?.moderatedByUserId).toBe(owner.userId);
  });

  it("lets a reviewer moderate but not an editor", async () => {
    const owner = await makeActor();
    const reviewer = await makeActor();
    const editor = await makeActor();
    const visitor = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, reviewer, "reviewer");
    await addMember(memorialId, editor, "editor");

    const a = await submitVisitorStory(
      visitor,
      memorialId,
      { body: "One.", sourceLocale: "en" },
      "r1",
    );
    const b = await submitVisitorStory(
      visitor,
      memorialId,
      { body: "Two.", sourceLocale: "en" },
      "r2",
    );
    if (!a.ok || !b.ok) throw new Error("submit failed");

    expect((await moderateSubmission(reviewer, a.value.submissionId, "published", "r3")).ok)
      .toBe(true);
    expect(await moderateSubmission(editor, b.value.submissionId, "published", "r4"))
      .toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });
  });

  it("cannot be moderated twice", async () => {
    const owner = await makeActor();
    const visitor = await makeActor();
    const memorialId = await makeMemorial(owner);

    const submitted = await submitVisitorStory(
      visitor,
      memorialId,
      { body: "Once.", sourceLocale: "en" },
      "r1",
    );
    if (!submitted.ok) throw new Error("submit failed");

    await moderateSubmission(owner, submitted.value.submissionId, "published", "r2");
    expect(
      await moderateSubmission(owner, submitted.value.submissionId, "rejected", "r3"),
    ).toEqual({ ok: false, error: "ALREADY_MODERATED" });
  });

  it("shows the pending queue only to someone who may moderate", async () => {
    const owner = await makeActor();
    const editor = await makeActor();
    const stranger = await makeActor();
    const visitor = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, editor, "editor");

    await submitVisitorStory(
      visitor,
      memorialId,
      { body: "Waiting.", sourceLocale: "en" },
      "r1",
    );

    const forOwner = await pendingVisitorStories(owner, memorialId);
    expect(forOwner.ok && forOwner.value).toHaveLength(1);

    expect(await pendingVisitorStories(editor, memorialId)).toEqual({
      ok: false,
      error: "MEMORIAL_FORBIDDEN",
    });
    expect(await pendingVisitorStories(stranger, memorialId)).toEqual({
      ok: false,
      error: "MEMORIAL_NOT_FOUND",
    });
  });
});

describe("translations", () => {
  async function publishedVersion(): Promise<{
    owner: Actor;
    memorialId: string;
    version: { id: string; title: string | null; body: string; sourceLocale: string };
  }> {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    await saveBiography(
      owner,
      memorialId,
      { title: "A life", body: "He taught mathematics.", sourceLocale: "en" },
      "r1",
    );
    await publishBiography(owner, memorialId, "r2");
    const published = await publishedBiography(memorialId);
    if (!published) throw new Error("expected a published biography");

    return {
      owner,
      memorialId,
      version: {
        id: published.versionId,
        title: published.title,
        body: published.body,
        sourceLocale: published.sourceLocale,
      },
    };
  }

  it("leaves the original untouched", async () => {
    const { owner, version } = await publishedVersion();

    await saveTranslation(
      owner,
      {
        contentVersionId: version.id,
        targetLocale: "zh-CN",
        body: "他教了数学。",
        method: "human",
        publish: true,
      },
      "r3",
    );

    const [stored] = await db()
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.id, version.id));

    expect(stored?.body).toBe("He taught mathematics.");
    expect(stored?.sourceLocale).toBe("en");
  });

  it("renders the translation for a reader who asked for that language", async () => {
    const { owner, version } = await publishedVersion();

    await saveTranslation(
      owner,
      {
        contentVersionId: version.id,
        targetLocale: "zh-CN",
        body: "他教了数学。",
        method: "human",
        publish: true,
      },
      "r3",
    );

    const rendered = await renderContent({ version, requestedLocale: "zh-CN" });

    expect(rendered.body).toBe("他教了数学。");
    expect(rendered.isTranslated).toBe(true);
    expect(rendered.method).toBe("human");
    expect(rendered.locale).toBe("zh-CN");
  });

  it("falls back to the original rather than returning nothing", async () => {
    // A memorial page that goes blank because a translation is missing is worse
    // for a family than one showing the language they wrote in.
    const { version } = await publishedVersion();

    const rendered = await renderContent({ version, requestedLocale: "ja" });

    expect(rendered.body).toBe("He taught mathematics.");
    expect(rendered.isTranslated).toBe(false);
    expect(rendered.locale).toBe("en");
    expect(rendered.requestedLocale).toBe("ja");
  });

  it("does not show a draft translation to readers", async () => {
    const { owner, version } = await publishedVersion();

    await saveTranslation(
      owner,
      {
        contentVersionId: version.id,
        targetLocale: "es",
        body: "Borrador sin revisar.",
        method: "human",
      },
      "r3",
    );

    const rendered = await renderContent({ version, requestedLocale: "es" });
    expect(rendered.isTranslated).toBe(false);
    expect(rendered.body).toBe("He taught mathematics.");
  });

  it("refuses to publish a machine translation without a reviewer", async () => {
    // Doc 07 section 3 and doc 05 section 7: a machine may draft, a person
    // takes responsibility for the wording.
    const { owner, version } = await publishedVersion();

    expect(
      await saveTranslation(
        owner,
        {
          contentVersionId: version.id,
          targetLocale: "fr",
          body: "Traduction automatique.",
          method: "machine",
          publish: true,
        },
        "r3",
      ),
    ).toEqual({ ok: false, error: "MACHINE_TRANSLATION_NEEDS_REVIEW" });
  });

  it("stores a machine draft and labels it once approved", async () => {
    const { owner, version } = await publishedVersion();

    const saved = await saveTranslation(
      owner,
      {
        contentVersionId: version.id,
        targetLocale: "fr",
        body: "Il enseignait les mathématiques.",
        method: "machine",
      },
      "r3",
    );
    if (!saved.ok) throw new Error("save failed");
    expect(saved.value.status).toBe("draft");

    await approveTranslation(owner, saved.value.translationId, "r4");

    const rendered = await renderContent({ version, requestedLocale: "fr" });
    expect(rendered.isTranslated).toBe(true);
    // The reader is told a machine produced this wording.
    expect(rendered.method).toBe("machine");

    const [row] = await db()
      .select()
      .from(contentTranslations)
      .where(eq(contentTranslations.id, saved.value.translationId));
    expect(row?.reviewerUserId).toBe(owner.userId);
    expect(row?.reviewedAt).toBeInstanceOf(Date);
  });

  it("refuses a translation into the language it was written in", async () => {
    const { owner, version } = await publishedVersion();

    expect(
      await saveTranslation(
        owner,
        {
          contentVersionId: version.id,
          targetLocale: "en",
          body: "Same language.",
          method: "human",
        },
        "r3",
      ),
    ).toEqual({ ok: false, error: "SAME_AS_SOURCE" });
  });

  it("is attached to a version, so a later edit is not silently translated", async () => {
    // The translation belongs to the wording it was made from. A new version
    // starts with no translation rather than inheriting one made from text that
    // has since changed.
    const { owner, memorialId, version } = await publishedVersion();

    await saveTranslation(
      owner,
      {
        contentVersionId: version.id,
        targetLocale: "zh-CN",
        body: "他教了数学。",
        method: "human",
        publish: true,
      },
      "r3",
    );

    await saveBiography(
      owner,
      memorialId,
      { body: "He taught mathematics and physics.", sourceLocale: "en" },
      "r4",
    );
    await publishBiography(owner, memorialId, "r5");

    const republished = await publishedBiography(memorialId);
    if (!republished) throw new Error("expected a published biography");

    const rendered = await renderContent({
      version: {
        id: republished.versionId,
        title: republished.title,
        body: republished.body,
        sourceLocale: republished.sourceLocale,
      },
      requestedLocale: "zh-CN",
    });

    expect(rendered.isTranslated).toBe(false);
    expect(rendered.body).toBe("He taught mathematics and physics.");
  });
});
