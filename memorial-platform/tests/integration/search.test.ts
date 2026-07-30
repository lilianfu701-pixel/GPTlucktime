import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  duplicateCandidates,
  memorialLocations,
  memorialNames,
  memorials,
  outboxEvents,
  searchDocuments,
  users,
} from "@/db/schema";
import { changePrivacy } from "@/modules/memorials/privacy";
import { createMemorial } from "@/modules/memorials/service";
import {
  findDuplicateCandidates,
  openCandidatesFor,
  recordDuplicateCandidates,
} from "@/modules/search/duplicates";
import { indexMemorial, removeFromIndex } from "@/modules/search/indexer";
import { MAX_LIMIT, MAX_OFFSET, searchMemorials } from "@/modules/search/query";
import type { Actor } from "@/modules/permissions/types";

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
    await db()
      .delete(duplicateCandidates)
      .where(inArray(duplicateCandidates.memorialId, memorialIds));
    await db()
      .delete(duplicateCandidates)
      .where(inArray(duplicateCandidates.candidateMemorialId, memorialIds));
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

/** A published, indexed memorial. */
async function publish(input: {
  name: string;
  aliases?: { value: string; searchable?: boolean }[];
  birth?: string;
  death?: string;
  country?: string;
  city?: string;
  visibility?: "public" | "unlisted" | "invite_only";
}): Promise<{ owner: Actor; memorialId: string }> {
  const owner = await makeActor();
  const result = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: input.name },
      aliases: input.aliases?.map((alias) => ({
        value: alias.value,
        type: "alias" as const,
        searchable: alias.searchable ?? true,
      })),
      ...(input.birth
        ? { birthDate: { value: input.birth, precision: "day" as const } }
        : {}),
      ...(input.death
        ? { deathDate: { value: input.death, precision: "day" as const } }
        : {}),
      ...(input.country || input.city
        ? {
            locations: [
              {
                kind: "death" as const,
                ...(input.country ? { country: input.country } : {}),
                ...(input.city ? { city: input.city } : {}),
              },
            ],
          }
        : {}),
      visibility: input.visibility ?? "public",
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

  return { owner, memorialId: result.value.memorialId };
}

const hitIds = (page: { hits: { memorialId: string }[] }): string[] =>
  page.hits.map((hit) => hit.memorialId);

describe("finding a public memorial", () => {
  it("by name", async () => {
    const { memorialId } = await publish({ name: `Mary OBrien ${randomUUID().slice(0, 6)}` });

    const result = await searchMemorials({ q: "mary obrien" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(hitIds(result.value)).toContain(memorialId);
  });

  it("by part of a name", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({ name: `Wang Minghua ${suffix}` });

    const result = await searchMemorials({ q: "minghua" });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });

  it("by a name written without accents", async () => {
    // Someone on a keyboard that cannot produce the accent should still find
    // their relative.
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({ name: `José Álvarez ${suffix}` });

    const result = await searchMemorials({ q: "jose alvarez" });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });

  it("by a Chinese name inside a longer one", async () => {
    // The case a word-based index cannot serve: there is no space to split on.
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({ name: `王明华${suffix}` });

    const result = await searchMemorials({ q: "王明" });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });

  it("by a searchable alias", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({
      name: `Primary Name ${suffix}`,
      aliases: [{ value: `Nickname ${suffix}` }],
    });

    const result = await searchMemorials({ q: `nickname ${suffix}` });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });

  it("by year of death", async () => {
    const { memorialId } = await publish({
      name: `Year Subject ${randomUUID().slice(0, 6)}`,
      death: "2019-05-04",
    });

    const result = await searchMemorials({ q: "year subject", deathYear: 2019 });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });

  it("by country", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({
      name: `Country Subject ${suffix}`,
      country: "PT",
    });

    const result = await searchMemorials({ q: `country subject ${suffix}`, country: "pt" });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });

  it("by place name", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({
      name: `Place Subject ${suffix}`,
      city: `Coimbra${suffix}`,
    });

    const result = await searchMemorials({ q: `coimbra${suffix}` });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });
});

describe("a name the family kept unsearchable", () => {
  it("does not make the memorial findable", async () => {
    // Doc 07 section 4: a family may record a former name without making it
    // findable, and that choice has to survive every reindex.
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({
      name: `Public Name ${suffix}`,
      aliases: [{ value: `Hidden Former ${suffix}`, searchable: false }],
    });

    const byHidden = await searchMemorials({ q: `hidden former ${suffix}` });
    expect(byHidden.ok && hitIds(byHidden.value)).not.toContain(memorialId);

    const byPublic = await searchMemorials({ q: `public name ${suffix}` });
    expect(byPublic.ok && hitIds(byPublic.value)).toContain(memorialId);
  });
});

describe("private memorials", () => {
  it("are absent when unlisted", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({
      name: `Unlisted Subject ${suffix}`,
      visibility: "unlisted",
    });

    const result = await searchMemorials({ q: `unlisted subject ${suffix}` });
    expect(result.ok && hitIds(result.value)).not.toContain(memorialId);
  });

  it("are absent when invite only", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({
      name: `Invite Subject ${suffix}`,
      visibility: "invite_only",
    });

    const result = await searchMemorials({ q: `invite subject ${suffix}` });
    expect(result.ok && hitIds(result.value)).not.toContain(memorialId);
  });

  it("are absent while still a draft", async () => {
    const suffix = randomUUID().slice(0, 6);
    const owner = await makeActor();
    const created = await createMemorial(
      owner,
      {
        relationship: "child",
        relationshipStatementAccepted: true,
        primaryName: { value: `Draft Subject ${suffix}` },
      },
      randomUUID(),
      "req_setup",
    );
    if (!created.ok) throw new Error("create failed");
    await indexMemorial(created.value.memorialId);

    const result = await searchMemorials({ q: `draft subject ${suffix}` });
    expect(result.ok && hitIds(result.value)).not.toContain(
      created.value.memorialId,
    );
  });

  it("are absent once deletion is requested", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({ name: `Deleting Subject ${suffix}` });

    await db()
      .update(memorials)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(memorials.id, memorialId));

    const result = await searchMemorials({ q: `deleting subject ${suffix}` });
    expect(result.ok && hitIds(result.value)).not.toContain(memorialId);
  });
});

describe("index lag cannot leak a memorial", () => {
  it("stops returning it the moment it stops being public", async () => {
    // The central property. The document is deliberately left in place, exactly
    // as it would be in the window before a worker cleans it up.
    const suffix = randomUUID().slice(0, 6);
    const { owner, memorialId } = await publish({ name: `Lag Subject ${suffix}` });

    const before = await searchMemorials({ q: `lag subject ${suffix}` });
    expect(before.ok && hitIds(before.value)).toContain(memorialId);

    await changePrivacy(owner, memorialId, { visibility: "invite_only" }, "r1");

    const stillIndexed = await db()
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.memorialId, memorialId));
    // The stale document is still there.
    expect(stillIndexed).toHaveLength(1);

    const after = await searchMemorials({ q: `lag subject ${suffix}` });
    expect(after.ok && hitIds(after.value)).not.toContain(memorialId);
  });

  it("returns it again if the family makes it public once more", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { owner, memorialId } = await publish({
      name: `Returning Subject ${suffix}`,
      visibility: "invite_only",
    });

    await changePrivacy(
      owner,
      memorialId,
      { visibility: "public", confirmPublicExposure: true },
      "r1",
    );

    const result = await searchMemorials({ q: `returning subject ${suffix}` });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });
});

describe("removing a document", () => {
  it("is cleanup rather than protection", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({ name: `Removed Subject ${suffix}` });

    await removeFromIndex(memorialId);

    const rows = await db()
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.memorialId, memorialId));
    expect(rows).toHaveLength(0);

    const result = await searchMemorials({ q: `removed subject ${suffix}` });
    expect(result.ok && hitIds(result.value)).not.toContain(memorialId);
  });
});

describe("query limits", () => {
  it("refuses a one-character query", async () => {
    // A single character matches almost everything and would hand back an
    // arbitrary slice of the platform.
    expect(await searchMemorials({ q: "a" })).toEqual({
      ok: false,
      error: "QUERY_TOO_SHORT",
    });
  });

  it("accepts a two-character query, for names that are two characters", async () => {
    const result = await searchMemorials({ q: "王明" });
    expect(result.ok).toBe(true);
  });

  it("refuses a search with no criteria at all", async () => {
    expect(await searchMemorials({})).toEqual({ ok: false, error: "NO_CRITERIA" });
    expect(await searchMemorials({ q: "   " })).toEqual({
      ok: false,
      error: "NO_CRITERIA",
    });
  });

  it("caps the page size", async () => {
    const result = await searchMemorials({ q: "subject", limit: 5000 });
    expect(result.ok && result.value.hits.length).toBeLessThanOrEqual(MAX_LIMIT);
  });

  it("stops paging before a search becomes a bulk export", async () => {
    // Doc 06 section 9 names bulk scraping as a threat. Someone looking for one
    // person finds them early; someone walking to a deep offset is building a
    // list.
    const result = await searchMemorials({
      q: "subject",
      cursor: String(MAX_OFFSET + 500),
    });
    expect(result.ok && result.value.nextCursor).toBeNull();
  });
});

describe("what a result discloses", () => {
  it("carries no owner, contact or relationship information", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { owner, memorialId } = await publish({
      name: `Disclosure Subject ${suffix}`,
      death: "2020-01-01",
    });

    const result = await searchMemorials({ q: `disclosure subject ${suffix}` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hit = result.value.hits.find((row) => row.memorialId === memorialId);
    expect(hit).toBeDefined();
    expect(Object.keys(hit ?? {}).sort()).toEqual([
      "birthYear",
      "countryCodes",
      "deathYear",
      "memorialId",
      "primaryName",
      "slug",
    ]);
    expect(JSON.stringify(hit)).not.toContain(owner.userId ?? "no-user");
  });

  it("shows the name as the family wrote it, not the match key", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({ name: `José Álvarez ${suffix}` });

    const result = await searchMemorials({ q: "jose alvarez" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hit = result.value.hits.find((row) => row.memorialId === memorialId);
    expect(hit?.primaryName).toBe(`José Álvarez ${suffix}`);
  });
});

describe("duplicate candidates", () => {
  it("are found when name and dates agree", async () => {
    const suffix = randomUUID().slice(0, 6);
    const first = await publish({
      name: `Duplicate Subject ${suffix}`,
      birth: "1948-03-02",
      death: "2020-07-11",
    });
    const second = await publish({
      name: `Duplicate Subject ${suffix}`,
      birth: "1948-03-02",
      death: "2020-07-11",
    });

    const matches = await findDuplicateCandidates(second.memorialId);
    expect(matches.map((match) => match.candidateMemorialId)).toContain(
      first.memorialId,
    );
  });

  it("record what the match was based on, not only a total", async () => {
    const suffix = randomUUID().slice(0, 6);
    const first = await publish({
      name: `Components Subject ${suffix}`,
      birth: "1950-01-01",
      death: "2021-02-02",
    });
    const second = await publish({
      name: `Components Subject ${suffix}`,
      birth: "1950-01-01",
      death: "2021-02-02",
    });

    const matches = await findDuplicateCandidates(second.memorialId);
    const match = matches.find(
      (candidate) => candidate.candidateMemorialId === first.memorialId,
    );

    expect(match).toBeDefined();
    expect(Object.keys(match?.components ?? {}).sort()).toEqual([
      "alias",
      "dates",
      "name",
      "place",
    ]);
    expect(match?.components.name).toBeGreaterThan(0);
    expect(match?.components.dates).toBe(1);
  });

  it("do not treat two unknown dates as agreement", async () => {
    // Otherwise every sparsely filled memorial looks like every other one.
    const suffix = randomUUID().slice(0, 6);
    await publish({ name: `Sparse One ${suffix}` });
    const second = await publish({ name: `Sparse Two ${suffix}` });

    const matches = await findDuplicateCandidates(second.memorialId);
    for (const match of matches) {
      expect(match.components.dates).toBe(0);
    }
  });

  it("do not match two different people who share nothing", async () => {
    await publish({
      name: `Alpha Person ${randomUUID().slice(0, 6)}`,
      death: "2001-01-01",
    });
    const second = await publish({
      name: `Beta Person ${randomUUID().slice(0, 6)}`,
      death: "2015-09-09",
    });

    expect(await findDuplicateCandidates(second.memorialId)).toHaveLength(0);
  });

  it("are never merged automatically", async () => {
    // Doc 03 section 7. Joining two families' pages is irreversible in the ways
    // that matter, and a score is not evidence.
    const suffix = randomUUID().slice(0, 6);
    const first = await publish({
      name: `Merge Subject ${suffix}`,
      death: "2020-04-04",
    });
    const second = await publish({
      name: `Merge Subject ${suffix}`,
      death: "2020-04-04",
    });

    const matches = await findDuplicateCandidates(second.memorialId);
    await recordDuplicateCandidates(second.memorialId, matches);

    const open = await openCandidatesFor(second.memorialId);
    expect(open.length).toBeGreaterThan(0);

    // Both memorials still exist, independently, and neither was hidden.
    const rows = await db()
      .select({ id: memorials.id, status: memorials.status })
      .from(memorials)
      .where(inArray(memorials.id, [first.memorialId, second.memorialId]));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("published");
    }
  });

  it("do not block a second memorial from being created", async () => {
    // A family creating a second memorial in grief deserves to be shown the
    // first one, not stopped by a number they cannot see.
    const suffix = randomUUID().slice(0, 6);
    await publish({ name: `Unblocked Subject ${suffix}`, death: "2020-01-01" });
    const second = await publish({
      name: `Unblocked Subject ${suffix}`,
      death: "2020-01-01",
    });

    const [row] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, second.memorialId));
    expect(row?.status).toBe("published");
  });

  it("are recorded once per pair, and updated on a rerun", async () => {
    const suffix = randomUUID().slice(0, 6);
    await publish({ name: `Rerun Subject ${suffix}`, death: "2020-06-06" });
    const second = await publish({
      name: `Rerun Subject ${suffix}`,
      death: "2020-06-06",
    });

    const matches = await findDuplicateCandidates(second.memorialId);
    await recordDuplicateCandidates(second.memorialId, matches);
    await recordDuplicateCandidates(second.memorialId, matches);

    const rows = await db()
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.memorialId, second.memorialId));
    expect(rows).toHaveLength(matches.length);
  });
});

describe("reindexing", () => {
  it("picks up a name added later", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({ name: `Original Name ${suffix}` });

    await db().insert(memorialNames).values({
      memorialId,
      value: `Added Later ${suffix}`,
      type: "alias",
      searchable: true,
    });
    await indexMemorial(memorialId);

    const result = await searchMemorials({ q: `added later ${suffix}` });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });

  it("picks up a location added later", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { memorialId } = await publish({ name: `Location Subject ${suffix}` });

    await db().insert(memorialLocations).values({
      memorialId,
      kind: "birth",
      country: "IE",
      city: `Galway${suffix}`,
    });
    await indexMemorial(memorialId);

    const result = await searchMemorials({ q: `galway${suffix}` });
    expect(result.ok && hitIds(result.value)).toContain(memorialId);
  });

  it("reports a memorial that no longer exists", async () => {
    expect(await indexMemorial(randomUUID())).toBe(false);
  });
});
