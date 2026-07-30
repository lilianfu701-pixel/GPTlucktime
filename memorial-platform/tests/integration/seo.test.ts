import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  blockedUsers,
  commemorations,
  deceasedPeople,
  disputeEvidence,
  exportJobs,
  memorialMembers,
  memorials,
  outboxEvents,
  ownershipDisputes,
  ritualDefinitions,
  ritualVersions,
  searchDocuments,
  users,
} from "@/db/schema";
import { resolveAccessById } from "@/modules/memorials/access";
import {
  RECOVERY_PERIOD_MS,
  cancelDeletion,
  memorialsDueForPurge,
  purgeMemorial,
  requestDeletion,
} from "@/modules/memorials/deletion";
import { buildManifest, requestExport } from "@/modules/memorials/export";
import { openOwnershipDispute } from "@/modules/governance/disputes";
import { indexMemorial } from "@/modules/search/indexer";
import { searchMemorials } from "@/modules/search/query";
import {
  alternatesFor,
  canonicalFor,
  isIndexable,
  robotsContent,
  robotsFor,
  statusForMemorial,
  structuredDataFor,
} from "@/modules/memorials/seo";
import { createMemorial } from "@/modules/memorials/service";
import type { Actor, MemorialRole } from "@/modules/permissions/types";

const createdUserIds: string[] = [];
const createdDefinitionIds: string[] = [];
const APP_URL = "https://memorial.example";

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
    const disputes = await db()
      .select({ id: ownershipDisputes.id })
      .from(ownershipDisputes)
      .where(inArray(ownershipDisputes.memorialId, memorialIds));
    if (disputes.length > 0) {
      await db()
        .delete(disputeEvidence)
        .where(inArray(disputeEvidence.disputeId, disputes.map((r) => r.id)));
      await db()
        .delete(ownershipDisputes)
        .where(inArray(ownershipDisputes.memorialId, memorialIds));
    }
    await db().delete(exportJobs).where(inArray(exportJobs.memorialId, memorialIds));
    await db()
      .delete(blockedUsers)
      .where(inArray(blockedUsers.memorialId, memorialIds));
    await db()
      .delete(commemorations)
      .where(inArray(commemorations.memorialId, memorialIds));
    await db()
      .delete(searchDocuments)
      .where(inArray(searchDocuments.memorialId, memorialIds));
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
  if (createdDefinitionIds.length > 0) {
    await db()
      .delete(ritualDefinitions)
      .where(inArray(ritualDefinitions.id, createdDefinitionIds));
  }
  await closeDb();
});

/**
 * A ritual version that satisfies the foreign key.
 *
 * Created directly rather than through the publication flow: this fixture only
 * needs a row a commemoration can point at, and going through the gates would
 * be testing the catalogue rather than deletion.
 */
async function makeRitualVersion(): Promise<string> {
  const [definition] = await db()
    .insert(ritualDefinitions)
    .values({
      slug: `seo-ritual-${randomUUID()}`,
      actionType: "offering",
      adminLabel: "Fixture ritual",
    })
    .returning({ id: ritualDefinitions.id });
  if (!definition) throw new Error("definition insert returned no row");
  createdDefinitionIds.push(definition.id);

  const [version] = await db()
    .insert(ritualVersions)
    .values({ definitionId: definition.id, version: 1, status: "published" })
    .returning({ id: ritualVersions.id });
  if (!version) throw new Error("version insert returned no row");
  return version.id;
}

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
  visibility: "public" | "unlisted" | "invite_only" = "public",
): Promise<{ owner: Actor; memorialId: string; slug: string }> {
  const owner = await makeActor();
  const result = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
      visibility,
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");

  await db()
    .update(memorials)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(memorials.id, result.value.memorialId));
  await indexMemorial(result.value.memorialId);

  return { owner, memorialId: result.value.memorialId, slug: result.value.slug };
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

const facts = (
  overrides: Partial<Parameters<typeof isIndexable>[0]> = {},
): Parameters<typeof isIndexable>[0] => ({
  slug: "someone-abcd1234",
  visibility: "public",
  status: "published",
  searchEngineIndexable: true,
  availableLocales: ["en"],
  ...overrides,
});

describe("what search engines are told", () => {
  it("indexes a public memorial the family left indexable", () => {
    expect(robotsContent(robotsFor(facts()))).toBe("index, follow");
  });

  it("refuses to index an unlisted or invite-only memorial", () => {
    for (const visibility of ["unlisted", "invite_only"] as const) {
      expect(robotsContent(robotsFor(facts({ visibility })))).toBe(
        "noindex, nofollow",
      );
    }
  });

  it("adds nofollow, not only noindex", () => {
    // A crawler that follows links out of an unlisted page maps the family's
    // other pages from it.
    expect(robotsFor(facts({ visibility: "unlisted" })).follow).toBe(false);
  });

  it("honours a family who is public but does not want to be indexed", () => {
    expect(
      robotsContent(robotsFor(facts({ searchEngineIndexable: false }))),
    ).toBe("noindex, nofollow");
  });

  it("does not index a draft or a hidden memorial", () => {
    for (const status of ["draft", "hidden", "pending_deletion"] as const) {
      expect(isIndexable(facts({ status }))).toBe(false);
    }
  });
});

describe("canonical and alternates", () => {
  it("point at the memorial when it is indexable", () => {
    expect(
      canonicalFor({ appUrl: APP_URL, locale: "en", memorial: facts() }),
    ).toBe("https://memorial.example/en/memorials/someone-abcd1234");
  });

  it("are absent for a private memorial", () => {
    // A private page should not publish a canonical pointing at itself.
    expect(
      canonicalFor({
        appUrl: APP_URL,
        locale: "en",
        memorial: facts({ visibility: "invite_only" }),
      }),
    ).toBeNull();
    expect(
      alternatesFor({
        appUrl: APP_URL,
        memorial: facts({ visibility: "invite_only" }),
      }),
    ).toEqual([]);
  });

  it("list only languages the memorial actually has", () => {
    // Advertising a translation that does not exist sends someone to a page in
    // a language they cannot read.
    const links = alternatesFor({
      appUrl: APP_URL,
      memorial: facts({ availableLocales: ["en", "zh-CN"] }),
    });

    expect(links.map((link) => link.hrefLang)).toEqual(["en", "zh-CN"]);
  });

  it("ignore a locale the platform does not serve", () => {
    const links = alternatesFor({
      appUrl: APP_URL,
      memorial: facts({ availableLocales: ["en", "xx-YY"] }),
    });

    expect(links.map((link) => link.hrefLang)).toEqual(["en"]);
  });
});

describe("structured data", () => {
  it("carries a name, years and the address, and nothing else", () => {
    // A machine-readable block listing a bereaved family's relationships is a
    // gift to anyone building a target list.
    const data = structuredDataFor({
      appUrl: APP_URL,
      locale: "en",
      memorial: facts(),
      primaryName: "Mary O'Brien",
      birthYear: 1948,
      deathYear: 2026,
    });

    expect(data).not.toBeNull();
    expect(Object.keys(data ?? {}).sort()).toEqual([
      "@context",
      "@type",
      "birthDate",
      "deathDate",
      "name",
      "url",
    ]);
  });

  it("publishes years rather than full dates", () => {
    // A full date of birth is a common identity-verification answer.
    const data = structuredDataFor({
      appUrl: APP_URL,
      locale: "en",
      memorial: facts(),
      primaryName: "Mary O'Brien",
      birthYear: 1948,
      deathYear: 2026,
    });

    expect(data?.birthDate).toBe("1948");
    expect(data?.deathDate).toBe("2026");
  });

  it("is absent entirely for a private memorial", () => {
    for (const visibility of ["unlisted", "invite_only"] as const) {
      expect(
        structuredDataFor({
          appUrl: APP_URL,
          locale: "en",
          memorial: facts({ visibility }),
          primaryName: "Mary O'Brien",
        }),
      ).toBeNull();
    }
  });
});

describe("page status", () => {
  it("is 410 for a deleted memorial that was public", () => {
    expect(
      statusForMemorial(facts({ status: "pending_deletion", visibility: "public" })),
    ).toBe(410);
  });

  it("is 404 for a deleted memorial that was private", () => {
    // Saying "gone" about a private memorial confirms it once existed.
    expect(
      statusForMemorial(
        facts({ status: "pending_deletion", visibility: "invite_only" }),
      ),
    ).toBe(404);
  });

  it("is 404 for an invite-only memorial and for one that never existed", () => {
    expect(statusForMemorial(facts({ visibility: "invite_only" }))).toBe(404);
    expect(statusForMemorial(null)).toBe(404);
  });

  it("redirects a merged memorial", () => {
    expect(statusForMemorial(facts({ status: "merged" }))).toBe(301);
  });
});

describe("requesting an export", () => {
  it("is allowed to the owner", async () => {
    const { owner, memorialId } = await makeMemorial();

    const result = await requestExport(owner, memorialId, randomUUID(), "r1");
    expect(result.ok && result.value.created).toBe(true);
  });

  it("is allowed to an administrator", async () => {
    const { memorialId } = await makeMemorial();
    const admin = await makeActor();
    await addMember(memorialId, admin, "admin");

    expect((await requestExport(admin, memorialId, randomUUID(), "r1")).ok).toBe(
      true,
    );
  });

  it("is refused to an editor", async () => {
    // Writing a biography does not entitle someone to walk away with every
    // message anyone left.
    const { memorialId } = await makeMemorial();
    const editor = await makeActor();
    await addMember(memorialId, editor, "editor");

    expect(await requestExport(editor, memorialId, randomUUID(), "r1")).toEqual({
      ok: false,
      error: "MEMORIAL_FORBIDDEN",
    });
  });

  it("tells a stranger the memorial does not exist", async () => {
    const { memorialId } = await makeMemorial();
    const stranger = await makeActor();

    expect(await requestExport(stranger, memorialId, randomUUID(), "r1")).toEqual({
      ok: false,
      error: "MEMORIAL_NOT_FOUND",
    });
  });

  it("returns the running job when retried", async () => {
    const { owner, memorialId } = await makeMemorial();
    const key = randomUUID();

    const first = await requestExport(owner, memorialId, key, "r1");
    const second = await requestExport(owner, memorialId, key, "r2");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.exportJobId).toBe(first.value.exportJobId);
    expect(second.value.created).toBe(false);
  });

  it("queues the work rather than building it in the request", async () => {
    const { owner, memorialId } = await makeMemorial();
    await requestExport(owner, memorialId, randomUUID(), "r1");

    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, memorialId));
    expect(events.map((e) => e.topic)).toContain("export.requested");
  });
});

describe("what an export contains", () => {
  it("carries the family's own record", async () => {
    const { memorialId } = await makeMemorial();

    const manifest = await buildManifest(memorialId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    expect(manifest.value.manifestVersion).toBe("1.0");
    expect(manifest.value.memorial.names.length).toBeGreaterThan(0);
  });

  it("excludes credentials, evidence, blocks and internal scores", async () => {
    // Doc 04 section 9. An export is a file that gets emailed and forwarded.
    const { owner, memorialId } = await makeMemorial();
    const claimant = await makeActor();
    const blocked = await makeActor();

    await openOwnershipDispute(
      claimant,
      { memorialId, claimedRelationship: "spouse", statement: "A claim." },
      "r1",
    );
    await db().insert(blockedUsers).values({
      memorialId,
      blockedUserId: blocked.userId ?? "",
      blockedByUserId: owner.userId,
      reason: "Repeated unkind messages.",
    });

    const manifest = await buildManifest(memorialId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    const serialized = JSON.stringify(manifest.value);

    expect(Object.keys(manifest.value).sort()).toEqual([
      "biography",
      "commemorations",
      "generatedAt",
      "manifestVersion",
      "media",
      "memorial",
      "timeline",
      "translations",
      "tributes",
      "visitorStories",
    ]);

    // Nothing from the dispute, the block, or any credential.
    expect(serialized).not.toContain("dispute-evidence");
    expect(serialized).not.toContain("A claim.");
    expect(serialized).not.toContain("Repeated unkind messages.");
    expect(serialized).not.toContain(blocked.userId ?? "no-user");
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain("codeHash");
  });

  it("describes translations without carrying unreviewed text", async () => {
    const { memorialId } = await makeMemorial();

    const manifest = await buildManifest(memorialId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    for (const translation of manifest.value.translations) {
      expect(Object.keys(translation).sort()).toEqual([
        "method",
        "reviewed",
        "status",
        "targetLocale",
      ]);
    }
  });
});

describe("deleting a memorial", () => {
  it("requires an explicit confirmation", async () => {
    const { owner, memorialId } = await makeMemorial();

    expect(
      await requestDeletion(owner, memorialId, { confirmed: false }, "r1"),
    ).toEqual({ ok: false, error: "CONFIRMATION_REQUIRED" });
  });

  it("is refused to an administrator", async () => {
    const { memorialId } = await makeMemorial();
    const admin = await makeActor();
    await addMember(memorialId, admin, "admin");

    expect(
      await requestDeletion(admin, memorialId, { confirmed: true }, "r1"),
    ).toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });
  });

  it("takes the page out of reach immediately", async () => {
    // Nothing about a family's decision waits on a worker.
    const { owner, memorialId } = await makeMemorial();

    expect(
      (await resolveAccessById(memorialId, { userId: null, platformRole: "user" }))
        .allowed,
    ).toBe(true);

    await requestDeletion(owner, memorialId, { confirmed: true }, "r1");

    expect(
      await resolveAccessById(memorialId, { userId: null, platformRole: "user" }),
    ).toEqual({ allowed: false, reason: "GONE" });
  });

  it("takes it out of search immediately, before any cleanup runs", async () => {
    const { owner, memorialId, slug } = await makeMemorial();

    await requestDeletion(owner, memorialId, { confirmed: true }, "r1");

    // The search document is still there; the query no longer returns it.
    const stillIndexed = await db()
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.memorialId, memorialId));
    expect(stillIndexed).toHaveLength(1);

    const found = await searchMemorials({ q: slug.split("-")[0] ?? "subject" });
    expect(
      found.ok && found.value.hits.map((hit) => hit.memorialId),
    ).not.toContain(memorialId);
  });

  it("sets a recovery period rather than destroying anything", async () => {
    const { owner, memorialId } = await makeMemorial();

    const result = await requestDeletion(owner, memorialId, { confirmed: true }, "r1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, memorialId));

    expect(row?.status).toBe("pending_deletion");
    expect(row?.purgeAfter).toBeInstanceOf(Date);
    expect(
      (row?.purgeAfter?.getTime() ?? 0) - (row?.deletionRequestedAt?.getTime() ?? 0),
    ).toBe(RECOVERY_PERIOD_MS);
  });

  it("can be undone inside the recovery period", async () => {
    // The whole point of the period: a decision made in the worst week of
    // someone's life can be reversed.
    const { owner, memorialId } = await makeMemorial();

    await requestDeletion(owner, memorialId, { confirmed: true }, "r1");
    const restored = await cancelDeletion(owner, memorialId, "r2");
    expect(restored.ok).toBe(true);

    const [row] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, memorialId));
    expect(row?.status).toBe("published");
    expect(row?.deletionRequestedAt).toBeNull();

    expect(
      (await resolveAccessById(memorialId, { userId: null, platformRole: "user" }))
        .allowed,
    ).toBe(true);
  });

  it("is refused while an ownership claim is open", async () => {
    // Deleting the page would settle the question by destroying what is being
    // contested.
    const { owner, memorialId } = await makeMemorial();
    const claimant = await makeActor();

    await openOwnershipDispute(
      claimant,
      { memorialId, claimedRelationship: "spouse", statement: "A claim." },
      "r1",
    );

    expect(
      await requestDeletion(owner, memorialId, { confirmed: true }, "r2"),
    ).toEqual({ ok: false, error: "OWNERSHIP_FROZEN" });
  });
});

describe("the final purge", () => {
  it("refuses to run before the recovery period has passed", async () => {
    const { owner, memorialId } = await makeMemorial();
    await requestDeletion(owner, memorialId, { confirmed: true }, "r1");

    expect(await purgeMemorial(memorialId, "r2")).toEqual({
      ok: false,
      error: "CONFIRMATION_REQUIRED",
    });

    // Nothing was destroyed.
    const docs = await db()
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.memorialId, memorialId));
    expect(docs).toHaveLength(1);
  });

  it("removes the search document once the period has passed", async () => {
    const { owner, memorialId } = await makeMemorial();
    await requestDeletion(owner, memorialId, { confirmed: true }, "r1");

    const afterPeriod = new Date(Date.now() + RECOVERY_PERIOD_MS + 1000);
    const result = await purgeMemorial(memorialId, "r2", afterPeriod);

    expect(result.ok).toBe(true);
    const docs = await db()
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.memorialId, memorialId));
    expect(docs).toHaveLength(0);
  });

  it("detaches visitors from their commemorations rather than deleting them", async () => {
    // Someone who came to light a candle performed an act of their own. The
    // family's decision to remove the page is not a decision about that
    // person's history.
    const { owner, memorialId } = await makeMemorial();
    const visitor = await makeActor();
    const ritualVersionId = await makeRitualVersion();

    await db().insert(commemorations).values({
      memorialId,
      ritualVersionId,
      actorUserId: visitor.userId,
      locale: "en",
      status: "visible",
      idempotencyKey: randomUUID(),
      requestHash: "hash",
      requestIpHash: "a".repeat(64),
    });

    await requestDeletion(owner, memorialId, { confirmed: true }, "r1");
    const afterPeriod = new Date(Date.now() + RECOVERY_PERIOD_MS + 1000);
    await purgeMemorial(memorialId, "r2", afterPeriod);

    const [act] = await db()
      .select()
      .from(commemorations)
      .where(eq(commemorations.memorialId, memorialId));

    expect(act).toBeDefined();
    expect(act?.actorUserId).toBeNull();
    expect(act?.anonymous).toBe(true);
    expect(act?.requestIpHash).toBeNull();
  });

  it("lists memorials whose period has run out", async () => {
    const { owner, memorialId } = await makeMemorial();
    await requestDeletion(owner, memorialId, { confirmed: true }, "r1");

    expect(await memorialsDueForPurge(new Date())).not.toContain(memorialId);
    expect(
      await memorialsDueForPurge(new Date(Date.now() + RECOVERY_PERIOD_MS + 1000)),
    ).toContain(memorialId);
  });
});
