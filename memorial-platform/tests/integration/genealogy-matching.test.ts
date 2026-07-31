import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  familyLinks,
  familyMatchSuggestions,
  familyPeople,
  memorials,
  outboxEvents,
  searchDocuments,
  users,
} from "@/db/schema";
import {
  acceptSuggestion,
  declineSuggestion,
  findMatches,
  isWorthSuggesting,
  scoreOf,
  suggestionsFor,
} from "@/modules/genealogy/matching";
import { addLivingRelative, addMemorialSubject } from "@/modules/genealogy/people";
import { createMemorial } from "@/modules/memorials/service";
import type { Actor } from "@/modules/permissions/types";

const createdUserIds: string[] = [];

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
});

afterEach(async () => {
  const userIds = createdUserIds.splice(0);
  if (userIds.length === 0) return;

  const people = await db()
    .select({ id: familyPeople.id })
    .from(familyPeople)
    .where(inArray(familyPeople.createdByUserId, userIds));
  const personIds = people.map((row) => row.id);

  if (personIds.length > 0) {
    await db()
      .delete(familyMatchSuggestions)
      .where(inArray(familyMatchSuggestions.olderPersonId, personIds));
    await db()
      .delete(familyMatchSuggestions)
      .where(inArray(familyMatchSuggestions.newerPersonId, personIds));
    await db().delete(familyLinks).where(inArray(familyLinks.personAId, personIds));
    await db().delete(familyLinks).where(inArray(familyLinks.personBId, personIds));
    await db().delete(familyPeople).where(inArray(familyPeople.id, personIds));
  }

  const owned = await db()
    .select({ id: memorials.id, personId: memorials.deceasedPersonId })
    .from(memorials)
    .where(inArray(memorials.ownerUserId, userIds));
  const memorialIds = owned.map((row) => row.id);

  if (memorialIds.length > 0) {
    await db()
      .delete(searchDocuments)
      .where(inArray(searchDocuments.memorialId, memorialIds));
    await db()
      .delete(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, memorialIds));
    await db().delete(auditLogs).where(inArray(auditLogs.resourceId, memorialIds));
    await db().delete(memorials).where(inArray(memorials.id, memorialIds));
    await db()
      .delete(deceasedPeople)
      .where(inArray(deceasedPeople.id, owned.map((row) => row.personId)));
  }

  await db().delete(auditLogs).where(inArray(auditLogs.actorUserId, userIds));
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

/** A living node. `waitAfter` keeps creation order unambiguous. */
async function livingNode(
  actor: Actor,
  name: string,
  birthYear?: number,
): Promise<string> {
  const result = await addLivingRelative(
    actor,
    { displayName: name, ...(birthYear !== undefined ? { birthYear } : {}) },
    "req",
  );
  if (!result.ok) throw new Error(`setup failed: ${result.error}`);
  // The older/newer ordering is decided by createdAt, so two nodes made in the
  // same millisecond would make these tests decide nothing.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return result.value.personId;
}

async function memorialNode(
  owner: Actor,
  name: string,
  dates?: { birth?: string; death?: string },
): Promise<{ personId: string; memorialId: string }> {
  const created = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: name },
      visibility: "public",
      ...(dates?.birth
        ? { birthDate: { value: dates.birth, precision: "day" as const } }
        : {}),
      ...(dates?.death
        ? { deathDate: { value: dates.death, precision: "day" as const } }
        : {}),
    },
    randomUUID(),
    "req",
  );
  if (!created.ok) throw new Error("memorial creation failed");

  const added = await addMemorialSubject(owner, created.value.memorialId, "req");
  if (!added.ok) throw new Error(`setup failed: ${added.error}`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { personId: added.value.personId, memorialId: created.value.memorialId };
}

describe("what is worth suggesting at all", () => {
  it("never suggests on a shared name alone", () => {
    // Half of a large country shares a surname. A suggestion that two people
    // with the same name might be the same person is noise, and noise trains
    // people to accept without looking.
    expect(
      isWorthSuggesting({ name: true, birthYear: false, deathYear: false }),
    ).toBe(false);
  });

  it("needs the name as well as a year", () => {
    expect(
      isWorthSuggesting({ name: false, birthYear: true, deathYear: true }),
    ).toBe(false);
  });

  it("suggests when a name and a year agree", () => {
    expect(
      isWorthSuggesting({ name: true, birthYear: true, deathYear: false }),
    ).toBe(true);
    expect(scoreOf({ name: true, birthYear: true, deathYear: false })).toBe(70);
  });
});

describe("finding the same person in two trees", () => {
  it("raises a suggestion when a name and year agree", async () => {
    const olderSide = await makeActor();
    const newerSide = await makeActor();
    const name = `Wang ${randomUUID().slice(0, 8)}`;

    const older = await livingNode(olderSide, name, 1943);
    const newer = await livingNode(newerSide, name, 1943);

    const run = await findMatches();
    expect(run.created).toBeGreaterThanOrEqual(1);

    const [row] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));

    expect(row).toBeDefined();
    expect(row!.newerPersonId).toBe(newer);
    expect(row!.status).toBe("open");
    expect(JSON.parse(row!.signals)).toMatchObject({ name: true, birthYear: true });
  });

  it("leaves two people with the same name and different years alone", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const name = `Li ${randomUUID().slice(0, 8)}`;

    const older = await livingNode(a, name, 1940);
    await livingNode(b, name, 1975);

    await findMatches();

    const rows = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));
    expect(rows).toEqual([]);
  });

  it("does not compare a date the family never gave us", async () => {
    // A memorial with no dates recorded must not match another on the strength
    // of a name, however common the name is.
    const a = await makeActor();
    const b = await makeActor();
    const name = `Chen ${randomUUID().slice(0, 8)}`;

    const first = await memorialNode(a, name);
    await memorialNode(b, name);

    await findMatches();

    const rows = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, first.personId));
    expect(rows).toEqual([]);
  });

  it("matches two memorials that agree on a name and a death year", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const name = `Zhao ${randomUUID().slice(0, 8)}`;

    const first = await memorialNode(a, name, { death: "1998-04-12" });
    const second = await memorialNode(b, name, { death: "1998-04-12" });

    await findMatches();

    const [row] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, first.personId));

    expect(row).toBeDefined();
    expect(row!.newerPersonId).toBe(second.personId);
  });

  it("raises a pair only once", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const name = `Sun ${randomUUID().slice(0, 8)}`;
    const older = await livingNode(a, name, 1950);
    await livingNode(b, name, 1950);

    await findMatches();
    await findMatches();

    const rows = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));
    expect(rows).toHaveLength(1);
  });
});

describe("the probing hole", () => {
  it("tells the newer side nothing until the older side has accepted", async () => {
    // Somebody could otherwise create nodes for guessed names and watch which
    // of them produce a suggestion, which would be an oracle for exactly the
    // records the platform refuses to confirm the existence of anywhere else.
    const established = await makeActor();
    const prober = await makeActor();
    const name = `Guo ${randomUUID().slice(0, 8)}`;

    await livingNode(established, name, 1962);
    await livingNode(prober, name, 1962);

    await findMatches();

    expect(await suggestionsFor(prober)).toEqual([]);
    expect(await suggestionsFor(established)).toHaveLength(1);
  });

  it("refuses the newer side's acceptance as if nothing existed", async () => {
    const established = await makeActor();
    const prober = await makeActor();
    const name = `Han ${randomUUID().slice(0, 8)}`;
    const older = await livingNode(established, name, 1955);
    await livingNode(prober, name, 1955);
    await findMatches();

    const [row] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));

    // Not FORBIDDEN, which would itself confirm there is something here.
    expect(await acceptSuggestion(prober, row!.id, "req")).toMatchObject({
      ok: false,
      error: "SUGGESTION_NOT_FOUND",
    });
  });

  it("shows the newer side only after the older side agrees", async () => {
    const established = await makeActor();
    const other = await makeActor();
    const name = `Xu ${randomUUID().slice(0, 8)}`;
    const older = await livingNode(established, name, 1948);
    await livingNode(other, name, 1948);
    await findMatches();

    const [row] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));

    expect(await acceptSuggestion(established, row!.id, "req")).toMatchObject({
      ok: true,
      value: { matched: false },
    });

    const theirs = await suggestionsFor(other);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.matched).toBe(false);
  });
});

describe("what each side is allowed to see", () => {
  it("names only the reader's own node", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const name = `Fang ${randomUUID().slice(0, 8)}`;
    const older = await livingNode(mine, name, 1960);
    const newer = await livingNode(theirs, name, 1960);
    await findMatches();

    const visible = await suggestionsFor(mine);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.yourPersonId).toBe(older);
    // The other side is not in the payload at all — not as an id, not as a name.
    expect(JSON.stringify(visible[0])).not.toContain(newer);
  });

  it("shows a stranger nothing", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const outsider = await makeActor();
    const name = `Deng ${randomUUID().slice(0, 8)}`;
    await livingNode(mine, name, 1971);
    await livingNode(theirs, name, 1971);
    await findMatches();

    expect(await suggestionsFor(outsider)).toEqual([]);
  });

  it("keeps the score as a working note rather than a verdict", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const name = `Cui ${randomUUID().slice(0, 8)}`;
    await livingNode(mine, name, 1937);
    await livingNode(theirs, name, 1937);
    await findMatches();

    const visible = await suggestionsFor(mine);
    // The components travel with the total, so somebody can see what actually
    // agreed instead of being handed a number about a relative.
    expect(visible[0]!.signals).toMatchObject({ name: true, birthYear: true });
    expect(visible[0]!.score).toBe(70);
  });
});

describe("two yeses", () => {
  it("becomes a match only when both sides accept", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const name = `Yao ${randomUUID().slice(0, 8)}`;
    const older = await livingNode(mine, name, 1966);
    await livingNode(theirs, name, 1966);
    await findMatches();

    const [row] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));

    const first = await acceptSuggestion(mine, row!.id, "req");
    expect(first).toMatchObject({ ok: true, value: { matched: false } });

    const second = await acceptSuggestion(theirs, row!.id, "req");
    expect(second).toMatchObject({ ok: true, value: { matched: true } });

    const [after] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.id, row!.id));
    expect(after!.status).toBe("matched");
    expect(after!.resolvedAt).not.toBeNull();
  });

  it("does not let one side accept twice to supply both", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const name = `Meng ${randomUUID().slice(0, 8)}`;
    const older = await livingNode(mine, name, 1959);
    await livingNode(theirs, name, 1959);
    await findMatches();

    const [row] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));

    await acceptSuggestion(mine, row!.id, "req");
    // The second yes has to come from the other family; that is the whole
    // protection.
    expect(await acceptSuggestion(mine, row!.id, "req")).toMatchObject({
      ok: false,
      error: "ALREADY_DECIDED",
    });

    const [after] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.id, row!.id));
    expect(after!.status).toBe("open");
  });
});

describe("saying no", () => {
  it("closes the suggestion without telling the other side anything", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const name = `Qian ${randomUUID().slice(0, 8)}`;
    const older = await livingNode(mine, name, 1944);
    await livingNode(theirs, name, 1944);
    await findMatches();

    const [row] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));

    expect(await declineSuggestion(mine, row!.id, "req")).toMatchObject({ ok: true });

    // Turning a refusal into a notification would hand out the fact that
    // somebody matching their relative exists and wants nothing to do with them.
    expect(await suggestionsFor(theirs)).toEqual([]);
    expect(await suggestionsFor(mine)).toEqual([]);
  });

  it("does not raise the same pair again after a refusal", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const name = `Lu ${randomUUID().slice(0, 8)}`;
    const older = await livingNode(mine, name, 1988);
    await livingNode(theirs, name, 1988);
    await findMatches();

    const [row] = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));
    await declineSuggestion(mine, row!.id, "req");

    await findMatches();

    // A family who said no once should not be asked again every time the job
    // runs.
    const rows = await db()
      .select()
      .from(familyMatchSuggestions)
      .where(eq(familyMatchSuggestions.olderPersonId, older));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("dismissed");
  });
});
