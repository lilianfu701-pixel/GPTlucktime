import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  familyLinks,
  familyPeople,
  memorials,
  outboxEvents,
  searchDocuments,
  users,
} from "@/db/schema";
import { addLivingRelative, addMemorialSubject, placeSelf } from "@/modules/genealogy/people";
import { confirmLink, proposeLink } from "@/modules/genealogy/links";
import { readTree, readTreeForMemorial } from "@/modules/genealogy/tree";
import type { Tree, VisibleNode } from "@/modules/genealogy/tree";
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

async function memorialNode(
  owner: Actor,
  visibility: "public" | "invite_only" = "public",
): Promise<{ personId: string; memorialId: string; name: string }> {
  const name = `Subject ${randomUUID().slice(0, 6)}`;
  const created = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: name },
      visibility,
    },
    randomUUID(),
    "req",
  );
  if (!created.ok) throw new Error("memorial creation failed");

  await db()
    .update(memorials)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(memorials.id, created.value.memorialId));

  const added = await addMemorialSubject(owner, created.value.memorialId, "req");
  if (!added.ok) throw new Error(`setup failed: ${added.error}`);

  return { personId: added.value.personId, memorialId: created.value.memorialId, name };
}

/** Confirms a parent edge between two families. */
async function linkParent(
  proposer: Actor,
  confirmer: Actor,
  parentId: string,
  childId: string,
): Promise<void> {
  const proposed = await proposeLink(
    proposer,
    { kind: "parent", parentId, childId },
    "req",
  );
  if (!proposed.ok) throw new Error(`propose failed: ${proposed.error}`);
  if (proposed.value.status === "confirmed") return;

  const confirmed = await confirmLink(confirmer, proposed.value.linkId, "req");
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error}`);
}

function visible(tree: Tree): VisibleNode[] {
  return tree.nodes.filter((node): node is VisibleNode => node.visible);
}

describe("reading a tree", () => {
  it("returns the people around the root", async () => {
    const actor = await makeActor();
    const me = await placeSelf(actor, "Me", "req");
    const father = await addLivingRelative(actor, { displayName: "Father" }, "req");
    const grandmother = await addLivingRelative(actor, { displayName: "Grandmother" }, "req");
    if (!me.ok || !father.ok || !grandmother.ok) throw new Error("setup failed");

    await linkParent(actor, actor, father.value.personId, me.value.personId);
    await linkParent(actor, actor, grandmother.value.personId, father.value.personId);

    const tree = await readTree(actor, me.value.personId);
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;

    expect(visible(tree.value).map((node) => node.name).sort()).toEqual([
      "Father",
      "Grandmother",
      "Me",
    ]);
    expect(tree.value.edges).toHaveLength(2);
  });

  it("stops at the depth asked for", async () => {
    const actor = await makeActor();
    const me = await placeSelf(actor, "Me", "req");
    const father = await addLivingRelative(actor, { displayName: "Father" }, "req");
    const grandmother = await addLivingRelative(actor, { displayName: "Grandmother" }, "req");
    if (!me.ok || !father.ok || !grandmother.ok) throw new Error("setup failed");

    await linkParent(actor, actor, father.value.personId, me.value.personId);
    await linkParent(actor, actor, grandmother.value.personId, father.value.personId);

    const tree = await readTree(actor, me.value.personId, { depth: 1 });
    if (!tree.ok) throw new Error("read failed");

    expect(visible(tree.value).map((node) => node.name).sort()).toEqual([
      "Father",
      "Me",
    ]);
  });

  it("refuses an unbounded walk", async () => {
    const actor = await makeActor();
    const me = await placeSelf(actor, "Me", "req");
    if (!me.ok) throw new Error("setup failed");

    expect(await readTree(actor, me.value.personId, { depth: 99 })).toMatchObject({
      ok: false,
      error: "DEPTH_TOO_LARGE",
    });
  });

  it("does not walk a link nobody confirmed", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const child = await memorialNode(mine);
    const parent = await memorialNode(theirs);

    await proposeLink(
      mine,
      { kind: "parent", parentId: parent.personId, childId: child.personId },
      "req",
    );

    const tree = await readTree(mine, child.personId);
    if (!tree.ok) throw new Error("read failed");

    // One family's belief is not a connection.
    expect(tree.value.nodes).toHaveLength(1);
    expect(tree.value.edges).toEqual([]);
  });
});

describe("a private memorial is never disclosed through an edge", () => {
  it("withholds the name, the slug and the id", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const child = await memorialNode(mine);
    const parent = await memorialNode(theirs, "invite_only");

    await linkParent(theirs, mine, parent.personId, child.personId);

    const tree = await readTree(mine, child.personId);
    if (!tree.ok) throw new Error("read failed");

    const names = visible(tree.value).map((node) => node.name);
    expect(names).toEqual([child.name]);

    // Nothing about the private memorial survives into the payload — not its
    // name, not its slug, not an id that could be used as a handle.
    const serialized = JSON.stringify(tree.value);
    expect(serialized).not.toContain(parent.name);
    expect(serialized).not.toContain(parent.personId);
    expect(serialized).not.toContain(parent.memorialId);
  });

  it("still shows that somebody is there", async () => {
    // Dropping the node would make the tree lie about its own shape, and the
    // gap would look like the reader's own records being incomplete.
    const mine = await makeActor();
    const theirs = await makeActor();
    const child = await memorialNode(mine);
    const parent = await memorialNode(theirs, "invite_only");

    await linkParent(theirs, mine, parent.personId, child.personId);

    const tree = await readTree(mine, child.personId);
    if (!tree.ok) throw new Error("read failed");

    expect(tree.value.nodes).toHaveLength(2);
    expect(tree.value.nodes.filter((node) => !node.visible)).toHaveLength(1);
    expect(tree.value.edges).toHaveLength(1);
  });

  it("names it once the memorial is public", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const child = await memorialNode(mine);
    const parent = await memorialNode(theirs, "public");

    await linkParent(theirs, mine, parent.personId, child.personId);

    const tree = await readTree(mine, child.personId);
    if (!tree.ok) throw new Error("read failed");

    expect(visible(tree.value).map((node) => node.name).sort()).toEqual(
      [child.name, parent.name].sort(),
    );
  });

  it("follows the memorial's privacy the moment it changes", async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const child = await memorialNode(mine);
    const parent = await memorialNode(theirs, "public");
    await linkParent(theirs, mine, parent.personId, child.personId);

    const before = await readTree(mine, child.personId);
    if (!before.ok) throw new Error("read failed");
    expect(visible(before.value)).toHaveLength(2);

    await db()
      .update(memorials)
      .set({ visibility: "invite_only" })
      .where(eq(memorials.id, parent.memorialId));

    // Read from the live row, so a family who closes their page is closed here
    // too, immediately, without waiting for anything to be rebuilt.
    const after = await readTree(mine, child.personId);
    if (!after.ok) throw new Error("read failed");
    expect(visible(after.value)).toHaveLength(1);
  });
});

describe("living people are not handed to the whole graph", () => {
  it("shows a living relative to the family it is linked to", async () => {
    const actor = await makeActor();
    const me = await placeSelf(actor, "Me", "req");
    const aunt = await addLivingRelative(actor, { displayName: "Aunt Mei" }, "req");
    if (!me.ok || !aunt.ok) throw new Error("setup failed");

    await linkParent(actor, actor, aunt.value.personId, me.value.personId);

    const tree = await readTree(actor, me.value.personId);
    if (!tree.ok) throw new Error("read failed");
    expect(visible(tree.value).map((node) => node.name)).toContain("Aunt Mei");
  });

  it("withholds a living relative from a family three steps away", async () => {
    // Somebody agreed to be connected to their own relative. They did not agree
    // to be handed the name of a living person they have never met.
    const mine = await makeActor();
    const theirs = await makeActor();
    const child = await memorialNode(mine);
    const bridge = await memorialNode(theirs);
    const theirLivingCousin = await addLivingRelative(
      theirs,
      { displayName: "Their living cousin" },
      "req",
    );
    if (!theirLivingCousin.ok) throw new Error("setup failed");

    await linkParent(theirs, mine, bridge.personId, child.personId);
    await linkParent(theirs, theirs, theirLivingCousin.value.personId, bridge.personId);

    const tree = await readTree(mine, child.personId, { depth: 3 });
    if (!tree.ok) throw new Error("read failed");

    expect(JSON.stringify(tree.value)).not.toContain("Their living cousin");
    expect(tree.value.nodes.filter((node) => !node.visible).length).toBeGreaterThan(0);
  });
});

describe("the tree on a memorial page", () => {
  it("refuses before reading anything when the memorial is not visible", async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const subject = await memorialNode(owner, "invite_only");

    // Not a side door into a page that answers 404 at its own address.
    expect(
      await readTreeForMemorial(stranger, subject.memorialId),
    ).toMatchObject({ ok: false, error: "PERSON_NOT_FOUND" });
  });

  it("returns the tree rooted at the memorial's subject", async () => {
    const owner = await makeActor();
    const subject = await memorialNode(owner, "public");
    const parent = await addLivingRelative(owner, { displayName: "Their mother" }, "req");
    if (!parent.ok) throw new Error("setup failed");

    await linkParent(owner, owner, parent.value.personId, subject.personId);

    const tree = await readTreeForMemorial(owner, subject.memorialId);
    if (!tree.ok) throw new Error("read failed");

    const rootNode = tree.value.nodes[tree.value.rootRef];
    expect(rootNode!.visible).toBe(true);
    expect((rootNode as VisibleNode).personId).toBe(subject.personId);
    expect(visible(tree.value).map((node) => node.name)).toContain("Their mother");
  });

  it("says nothing different for a memorial with no tree", async () => {
    const owner = await makeActor();
    const created = await createMemorial(
      owner,
      {
        relationship: "child",
        relationshipStatementAccepted: true,
        primaryName: { value: `Alone ${randomUUID().slice(0, 6)}` },
        visibility: "public",
      },
      randomUUID(),
      "req",
    );
    if (!created.ok) throw new Error("setup failed");

    expect(
      await readTreeForMemorial(owner, created.value.memorialId),
    ).toMatchObject({ ok: false, error: "PERSON_NOT_FOUND" });
  });
});
