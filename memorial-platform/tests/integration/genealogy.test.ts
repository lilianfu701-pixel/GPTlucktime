import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  familyLinks,
  familyPeople,
  memorialMembers,
  memorials,
  outboxEvents,
  searchDocuments,
  users,
} from "@/db/schema";
import {
  addLivingRelative,
  addMemorialSubject,
  claimNode,
  placeSelf,
} from "@/modules/genealogy/people";
import {
  confirmLink,
  immediateLinks,
  pendingForActor,
  proposeLink,
  rejectLink,
  siblingsOf,
} from "@/modules/genealogy/links";
import { stewardshipOf } from "@/modules/genealogy/steward";
import { createMemorial } from "@/modules/memorials/service";
import type { Actor, MemorialRole } from "@/modules/permissions/types";

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
      .delete(familyLinks)
      .where(inArray(familyLinks.personAId, personIds));
    await db()
      .delete(familyLinks)
      .where(inArray(familyLinks.personBId, personIds));
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

async function makeMemorial(owner: Actor): Promise<string> {
  const result = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
      visibility: "public",
    },
    randomUUID(),
    "req_tree",
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

/** A node for a memorial the actor owns. */
async function nodeFor(owner: Actor): Promise<string> {
  const memorialId = await makeMemorial(owner);
  const result = await addMemorialSubject(owner, memorialId, "req_tree");
  if (!result.ok) throw new Error(`could not add subject: ${result.error}`);
  return result.value.personId;
}

describe("putting people in a tree", () => {
  it("points at the memorial's record instead of copying the name", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const added = await addMemorialSubject(owner, memorialId, "req");
    expect(added.ok).toBe(true);

    const [node] = await db()
      .select()
      .from(familyPeople)
      .where(eq(familyPeople.id, added.ok ? added.value.personId : ""));

    // A name copied here would keep showing a name the family later corrected,
    // or one they marked unsearchable.
    expect(node!.displayName).toBeNull();
    expect(node!.deceasedPersonId).not.toBeNull();
    expect(node!.lifeStatus).toBe("deceased");
  });

  it("lands two relatives on one node rather than splitting the graph", async () => {
    const owner = await makeActor();
    const sibling = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, sibling, "admin");

    const first = await addMemorialSubject(owner, memorialId, "req");
    const second = await addMemorialSubject(sibling, memorialId, "req");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.personId).toBe(first.value.personId);
    expect(second.value.created).toBe(false);
  });

  it("refuses someone with no role, without confirming the memorial exists", async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner);

    const result = await addMemorialSubject(stranger, memorialId, "req");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not FORBIDDEN: that would confirm there is something here.
    expect(result.error).toBe("MEMORIAL_NOT_FOUND");
  });

  it("does not let an editor attach the memorial to a family", async () => {
    const owner = await makeActor();
    const editor = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, editor, "editor");

    const result = await addMemorialSubject(editor, memorialId, "req");
    expect(result).toMatchObject({ ok: false, error: "MEMORIAL_FORBIDDEN" });
  });
});

describe("living relatives", () => {
  it("records a name and at most a year", async () => {
    const actor = await makeActor();
    const added = await addLivingRelative(
      actor,
      { displayName: "  Aunt Mei  ", birthYear: 1951 },
      "req",
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const [node] = await db()
      .select()
      .from(familyPeople)
      .where(eq(familyPeople.id, added.value.personId));

    expect(node!.displayName).toBe("Aunt Mei");
    expect(node!.birthYear).toBe(1951);
    expect(node!.lifeStatus).toBe("living");
    // This person never agreed to be here. There is nowhere to put anything
    // more about them, and that is the point.
    expect(node!.deceasedPersonId).toBeNull();
    expect(Object.keys(node!)).not.toContain("email");
  });

  it("refuses a year that cannot be right", async () => {
    const actor = await makeActor();
    const future = new Date().getUTCFullYear() + 1;

    expect(
      await addLivingRelative(actor, { displayName: "X", birthYear: future }, "req"),
    ).toMatchObject({ ok: false, error: "IMPLAUSIBLE_YEARS" });
    expect(
      await addLivingRelative(actor, { displayName: "X", birthYear: 800 }, "req"),
    ).toMatchObject({ ok: false, error: "IMPLAUSIBLE_YEARS" });
  });

  it("refuses a nameless node", async () => {
    const actor = await makeActor();
    expect(
      await addLivingRelative(actor, { displayName: "   " }, "req"),
    ).toMatchObject({ ok: false, error: "NAME_REQUIRED" });
  });

  it("gives an account exactly one node of its own", async () => {
    const actor = await makeActor();
    const first = await placeSelf(actor, "Me", "req");
    const second = await placeSelf(actor, "Me again", "req");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Two would make "who speaks for this person" ambiguous in the one case
    // where it must be certain.
    expect(second.value.personId).toBe(first.value.personId);
    expect(second.value.created).toBe(false);
  });
});

describe("who may speak for a node", () => {
  it("follows the memorial, so ownership transfer carries it", async () => {
    const owner = await makeActor();
    const successor = await makeActor();
    const memorialId = await makeMemorial(owner);
    const personId = (await addMemorialSubject(owner, memorialId, "req")) as {
      ok: true;
      value: { personId: string };
    };

    expect(await stewardshipOf(owner, personId.value.personId)).toMatchObject({
      kind: "memorial",
      allowed: true,
    });
    expect(
      await stewardshipOf(successor, personId.value.personId),
    ).toMatchObject({ allowed: false });

    // Hand it over.
    await db()
      .update(memorials)
      .set({ ownerUserId: successor.userId! })
      .where(eq(memorials.id, memorialId));
    await db()
      .delete(memorialMembers)
      .where(eq(memorialMembers.memorialId, memorialId));
    await addMember(memorialId, successor, "owner");

    // A former owner must stop being able to answer for their relative the
    // moment they hand the memorial over.
    expect(
      await stewardshipOf(successor, personId.value.personId),
    ).toMatchObject({ allowed: true });
    expect(await stewardshipOf(owner, personId.value.personId)).toMatchObject({
      allowed: false,
    });
  });

  it("moves to the living person once they claim their node", async () => {
    const recorder = await makeActor();
    const subject = await makeActor();
    const added = await addLivingRelative(recorder, { displayName: "Cousin" }, "req");
    if (!added.ok) throw new Error("setup failed");

    expect(await stewardshipOf(recorder, added.value.personId)).toMatchObject({
      kind: "creator",
      allowed: true,
    });

    const claimed = await claimNode(subject, added.value.personId, "req");
    expect(claimed.ok).toBe(true);

    // Nobody answers questions about a living person's family on their behalf
    // once they are here to answer for themselves.
    expect(await stewardshipOf(subject, added.value.personId)).toMatchObject({
      kind: "self",
      allowed: true,
    });
    expect(await stewardshipOf(recorder, added.value.personId)).toMatchObject({
      kind: "self",
      allowed: false,
    });
  });
});

describe("building your own tree", () => {
  it("confirms immediately when both sides are yours", async () => {
    const actor = await makeActor();
    const me = await placeSelf(actor, "Me", "req");
    const parent = await addLivingRelative(actor, { displayName: "My father" }, "req");
    if (!me.ok || !parent.ok) throw new Error("setup failed");

    const link = await proposeLink(
      actor,
      { kind: "parent", parentId: parent.value.personId, childId: me.value.personId },
      "req",
    );

    // There is no second family to ask. Making somebody confirm with
    // themselves would be theatre.
    expect(link).toMatchObject({ ok: true, value: { status: "confirmed" } });
  });

  it("records how a parent relationship came about only if asked", async () => {
    const actor = await makeActor();
    const me = await placeSelf(actor, "Me", "req");
    const parent = await addLivingRelative(actor, { displayName: "Dad" }, "req");
    if (!me.ok || !parent.ok) throw new Error("setup failed");

    const link = await proposeLink(
      actor,
      { kind: "parent", parentId: parent.value.personId, childId: me.value.personId },
      "req",
    );
    if (!link.ok) throw new Error("link failed");

    const [row] = await db()
      .select({ nature: familyLinks.nature })
      .from(familyLinks)
      .where(eq(familyLinks.id, link.value.linkId));

    // Never inferred, never required. A tree that demands this field forces
    // every adoptive family to declare itself.
    expect(row!.nature).toBe("unspecified");
  });
});

describe("connecting two families", () => {
  it("stays a proposal until the other side agrees", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const myNode = await nodeFor(mine);
    const theirNode = await nodeFor(theirs);

    const link = await proposeLink(
      mine,
      { kind: "parent", parentId: theirNode, childId: myNode },
      "req",
    );
    expect(link).toMatchObject({ ok: true, value: { status: "proposed" } });

    // Not traversed. Proposing a link is not a way to read your way into a
    // family that has not agreed to know you.
    expect(await immediateLinks(myNode)).toEqual([]);
    expect(await immediateLinks(theirNode)).toEqual([]);
  });

  it("refuses a proposal from someone with no side", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const outsider = await makeActor();

    const result = await proposeLink(
      outsider,
      { kind: "parent", parentId: await nodeFor(theirs), childId: await nodeFor(mine) },
      "req",
    );

    expect(result).toMatchObject({ ok: false, error: "NOT_YOUR_SIDE" });
  });

  it("does not let the proposer supply the second yes", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const link = await proposeLink(
      mine,
      { kind: "parent", parentId: await nodeFor(theirs), childId: await nodeFor(mine) },
      "req",
    );
    if (!link.ok) throw new Error("setup failed");

    // The whole protection is that the second yes comes from somebody else.
    expect(await confirmLink(mine, link.value.linkId, "req")).toMatchObject({
      ok: false,
      error: "NOT_YOUR_SIDE",
    });
  });

  it("hides the proposal from someone it has nothing to do with", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const outsider = await makeActor();
    const link = await proposeLink(
      mine,
      { kind: "parent", parentId: await nodeFor(theirs), childId: await nodeFor(mine) },
      "req",
    );
    if (!link.ok) throw new Error("setup failed");

    // LINK_NOT_FOUND, not FORBIDDEN: a stranger must not learn that two
    // families are being connected.
    expect(await confirmLink(outsider, link.value.linkId, "req")).toMatchObject({
      ok: false,
      error: "LINK_NOT_FOUND",
    });
    expect(await pendingForActor(outsider)).toEqual([]);
  });

  it("becomes traversable once the other side confirms", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const myNode = await nodeFor(mine);
    const theirNode = await nodeFor(theirs);

    const link = await proposeLink(
      mine,
      { kind: "parent", parentId: theirNode, childId: myNode },
      "req",
    );
    if (!link.ok) throw new Error("setup failed");

    const waiting = await pendingForActor(theirs);
    expect(waiting.map((row) => row.linkId)).toContain(link.value.linkId);

    expect(await confirmLink(theirs, link.value.linkId, "req")).toMatchObject({
      ok: true,
    });

    const relatives = await immediateLinks(myNode);
    expect(relatives).toHaveLength(1);
    expect(relatives[0]).toMatchObject({ otherPersonId: theirNode, role: "parent" });
    expect((await immediateLinks(theirNode))[0]).toMatchObject({
      otherPersonId: myNode,
      role: "child",
    });
  });

  it("keeps a refusal rather than deleting it", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const link = await proposeLink(
      mine,
      { kind: "parent", parentId: await nodeFor(theirs), childId: await nodeFor(mine) },
      "req",
    );
    if (!link.ok) throw new Error("setup failed");

    expect(await rejectLink(theirs, link.value.linkId, "req")).toMatchObject({
      ok: true,
    });

    const [row] = await db()
      .select({ status: familyLinks.status })
      .from(familyLinks)
      .where(eq(familyLinks.id, link.value.linkId));

    // A family who said no once should not have to say it again every week
    // with nothing showing they already answered.
    expect(row!.status).toBe("rejected");
    expect(await confirmLink(theirs, link.value.linkId, "req")).toMatchObject({
      ok: false,
      error: "ALREADY_DECIDED",
    });
  });

  it("tells a withdrawal apart from a refusal", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const link = await proposeLink(
      mine,
      { kind: "parent", parentId: await nodeFor(theirs), childId: await nodeFor(mine) },
      "req",
    );
    if (!link.ok) throw new Error("setup failed");

    await rejectLink(mine, link.value.linkId, "req");

    const [row] = await db()
      .select({ status: familyLinks.status })
      .from(familyLinks)
      .where(eq(familyLinks.id, link.value.linkId));

    // "They said no" and "we changed our mind" are different facts about a
    // family, and only one of them should discourage asking again.
    expect(row!.status).toBe("withdrawn");
  });
});

describe("partners", () => {
  it("stores one edge however the pair is given", async () => {
    const actor = await makeActor();
    const a = await placeSelf(actor, "Me", "req");
    const b = await addLivingRelative(actor, { displayName: "Spouse" }, "req");
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const first = await proposeLink(
      actor,
      { kind: "partner", personId: a.value.personId, partnerId: b.value.personId },
      "req",
    );
    const reversed = await proposeLink(
      actor,
      { kind: "partner", personId: b.value.personId, partnerId: a.value.personId },
      "req",
    );

    expect(first.ok).toBe(true);
    // Two rows for one marriage would eventually leave one of them confirmed
    // alone.
    expect(reversed).toMatchObject({ ok: false, error: "ALREADY_LINKED" });
  });

  it("refuses to marry someone to themselves", async () => {
    const actor = await makeActor();
    const me = await placeSelf(actor, "Me", "req");
    if (!me.ok) throw new Error("setup failed");

    expect(
      await proposeLink(
        actor,
        { kind: "partner", personId: me.value.personId, partnerId: me.value.personId },
        "req",
      ),
    ).toMatchObject({ ok: false, error: "SAME_PERSON" });
  });
});

describe("a person cannot be their own ancestor", () => {
  it("refuses a loop at proposal time", async () => {
    const actor = await makeActor();
    const grandparent = await addLivingRelative(actor, { displayName: "A" }, "req");
    const parent = await addLivingRelative(actor, { displayName: "B" }, "req");
    const child = await addLivingRelative(actor, { displayName: "C" }, "req");
    if (!grandparent.ok || !parent.ok || !child.ok) throw new Error("setup failed");

    await proposeLink(
      actor,
      { kind: "parent", parentId: grandparent.value.personId, childId: parent.value.personId },
      "req",
    );
    await proposeLink(
      actor,
      { kind: "parent", parentId: parent.value.personId, childId: child.value.personId },
      "req",
    );

    // C is A's grandchild; making C A's parent would close the loop.
    expect(
      await proposeLink(
        actor,
        { kind: "parent", parentId: child.value.personId, childId: grandparent.value.personId },
        "req",
      ),
    ).toMatchObject({ ok: false, error: "WOULD_CREATE_CYCLE" });
  });

  it("refuses a loop that only closes at confirmation time", async () => {
    // Two proposals that are each harmless on their own. Checking only at
    // proposal time would let whichever is confirmed second close the loop.
    const mine = await makeActor();
    const theirs = await makeActor();
    const a = await nodeFor(mine);
    const b = await nodeFor(theirs);

    const down = await proposeLink(mine, { kind: "parent", parentId: a, childId: b }, "req");
    const up = await proposeLink(theirs, { kind: "parent", parentId: b, childId: a }, "req");
    if (!down.ok) throw new Error("setup failed");

    // The second proposal is already refused, because proposals count towards
    // ancestry too.
    expect(up).toMatchObject({ ok: false, error: "WOULD_CREATE_CYCLE" });

    expect(await confirmLink(theirs, down.value.linkId, "req")).toMatchObject({
      ok: true,
    });
  });
});

describe("siblings are worked out, not stored", () => {
  it("finds two children of one confirmed parent", async () => {
    const actor = await makeActor();
    const parent = await addLivingRelative(actor, { displayName: "Parent" }, "req");
    const one = await addLivingRelative(actor, { displayName: "One" }, "req");
    const two = await addLivingRelative(actor, { displayName: "Two" }, "req");
    if (!parent.ok || !one.ok || !two.ok) throw new Error("setup failed");

    await proposeLink(
      actor,
      { kind: "parent", parentId: parent.value.personId, childId: one.value.personId },
      "req",
    );
    await proposeLink(
      actor,
      { kind: "parent", parentId: parent.value.personId, childId: two.value.personId },
      "req",
    );

    expect(await siblingsOf(one.value.personId)).toEqual([two.value.personId]);
    expect(await siblingsOf(two.value.personId)).toEqual([one.value.personId]);
  });

  it("does not invent a sibling from a parent link nobody confirmed", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const parent = await nodeFor(theirs);
    const child = await nodeFor(mine);
    const other = await addLivingRelative(theirs, { displayName: "Their child" }, "req");
    if (!other.ok) throw new Error("setup failed");

    await proposeLink(theirs, { kind: "parent", parentId: parent, childId: other.value.personId }, "req");
    await proposeLink(mine, { kind: "parent", parentId: parent, childId: child }, "req");

    // The second link is only proposed. Treating it as a sibling relationship
    // would announce a family connection that nobody has agreed to.
    expect(await siblingsOf(child)).toEqual([]);
  });
});
