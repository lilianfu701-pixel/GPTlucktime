import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  familyLinks,
  familyPeople,
  memorialNames,
  memorials,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { resolveAccessById } from "@/modules/memorials/access";
import type { Actor } from "@/modules/permissions/types";

export type TreeError = "PERSON_NOT_FOUND" | "DEPTH_TOO_LARGE";

/** Generations either side of the root. */
export const DEFAULT_DEPTH = 3;
export const MAX_DEPTH = 5;

/**
 * A node the reader is allowed to see.
 *
 * `personId` is here because the reader may act on it — propose a link, open
 * the memorial. A withheld node has no id at all, deliberately.
 */
export type VisibleNode = {
  visible: true;
  /** Index used by the edge list. */
  ref: number;
  personId: string;
  name: string;
  lifeStatus: "living" | "deceased" | "unknown";
  birthYear: number | null;
  deathYear: number | null;
  memorialSlug: string | null;
};

/**
 * Somebody is there, and that is all the reader is told.
 *
 * The alternative is worse in both directions. Dropping the node entirely
 * would make the tree lie about its own shape — a family would see two
 * grandparents where there are three, and the missing one would look like a
 * gap in their records rather than someone else's privacy. Naming it would
 * disclose a memorial that answers 404 to this reader everywhere else in the
 * system.
 *
 * There is no id, so a withheld node cannot be used as a handle to probe with:
 * you cannot propose a link to it, look it up, or tell two of them apart.
 */
export type WithheldNode = {
  visible: false;
  ref: number;
};

export type TreeNode = VisibleNode | WithheldNode;

export type TreeEdge = {
  kind: "parent" | "partner";
  /** For `parent`, the parent's ref. */
  fromRef: number;
  toRef: number;
};

export type Tree = {
  rootRef: number;
  nodes: TreeNode[];
  edges: TreeEdge[];
};

type RawPerson = {
  id: string;
  deceasedPersonId: string | null;
  displayName: string | null;
  lifeStatus: "living" | "deceased" | "unknown";
  birthYear: number | null;
  deathYear: number | null;
  createdByUserId: string;
  selfUserId: string | null;
};

async function loadPeople(ids: string[]): Promise<Map<string, RawPerson>> {
  if (ids.length === 0) return new Map();

  const rows = await db()
    .select({
      id: familyPeople.id,
      deceasedPersonId: familyPeople.deceasedPersonId,
      displayName: familyPeople.displayName,
      lifeStatus: familyPeople.lifeStatus,
      birthYear: familyPeople.birthYear,
      deathYear: familyPeople.deathYear,
      createdByUserId: familyPeople.createdByUserId,
      selfUserId: familyPeople.selfUserId,
    })
    .from(familyPeople)
    .where(inArray(familyPeople.id, ids));

  return new Map(rows.map((row) => [row.id, row]));
}

/** Confirmed edges touching any of these people. Nothing else is traversed. */
async function loadEdges(ids: string[]): Promise<
  { kind: "parent" | "partner"; personAId: string; personBId: string }[]
> {
  if (ids.length === 0) return [];

  const rows = await db()
    .select({
      kind: familyLinks.kind,
      personAId: familyLinks.personAId,
      personBId: familyLinks.personBId,
    })
    .from(familyLinks)
    .where(
      and(
        // A proposal is one family's belief. Traversing it would let somebody
        // read their way into a family that has not agreed to know them.
        eq(familyLinks.status, "confirmed"),
        or(
          inArray(familyLinks.personAId, ids),
          inArray(familyLinks.personBId, ids),
        ),
      ),
    );

  return rows;
}

/**
 * Whether the reader may be told who a node is.
 *
 * For a node backed by a memorial the question is handed straight to the
 * memorial's own access rules, so a tree can never be a way around them: an
 * invite-only memorial is as invisible here as it is at its own address.
 *
 * A living placeholder is shown to the person who recorded it, to the person it
 * is about, and to anyone who speaks for a node it is directly linked to. It is
 * not shown to the rest of a large graph. Somebody four steps away agreed to be
 * connected to their own relative, not to be handed the name of a living person
 * they have never met.
 */
async function mayName(
  actor: Actor,
  person: RawPerson,
  neighbourStewardIds: Set<string>,
): Promise<boolean> {
  if (person.deceasedPersonId) {
    const [memorial] = await db()
      .select({ id: memorials.id })
      .from(memorials)
      .where(
        and(
          eq(memorials.deceasedPersonId, person.deceasedPersonId),
          isNull(memorials.deletionRequestedAt),
        ),
      );

    if (!memorial) return false;
    return (await resolveAccessById(memorial.id, actor)).allowed;
  }

  if (!actor.userId) return false;
  if (person.selfUserId === actor.userId) return true;
  if (person.createdByUserId === actor.userId) return true;
  return neighbourStewardIds.has(person.id);
}

async function displayFor(
  person: RawPerson,
): Promise<{ name: string; slug: string | null }> {
  if (!person.deceasedPersonId) {
    return { name: person.displayName ?? "", slug: null };
  }

  const [row] = await db()
    .select({ name: memorialNames.value, slug: memorials.slug })
    .from(memorials)
    .innerJoin(
      memorialNames,
      and(
        eq(memorialNames.memorialId, memorials.id),
        eq(memorialNames.type, "primary"),
      ),
    )
    .where(eq(memorials.deceasedPersonId, person.deceasedPersonId));

  return { name: row?.name ?? "", slug: row?.slug ?? null };
}

/**
 * Reads the family graph around one person.
 *
 * Breadth first over confirmed edges only, to a bounded depth. Every node is
 * asked about separately: being reachable through the graph is never itself a
 * reason to be told who someone is. That is the whole design — an edge two
 * families agreed on does not extend to a third family standing behind one of
 * them.
 */
export async function readTree(
  actor: Actor,
  rootPersonId: string,
  options: { depth?: number } = {},
): Promise<Result<Tree, TreeError>> {
  const depth = options.depth ?? DEFAULT_DEPTH;
  if (depth < 1 || depth > MAX_DEPTH) {
    return err("DEPTH_TOO_LARGE");
  }

  const rootMap = await loadPeople([rootPersonId]);
  const root = rootMap.get(rootPersonId);
  if (!root) {
    return err("PERSON_NOT_FOUND");
  }

  // Which nodes the reader speaks for, so their immediate living relatives can
  // be named. Collected before the walk, from the reader's own side only.
  const ownNodes = actor.userId
    ? await db()
        .select({ id: familyPeople.id })
        .from(familyPeople)
        .where(eq(familyPeople.createdByUserId, actor.userId))
    : [];
  const ownIds = new Set(ownNodes.map((row) => row.id));

  const seen = new Set<string>([rootPersonId]);
  let frontier = [rootPersonId];
  const allEdges: { kind: "parent" | "partner"; personAId: string; personBId: string }[] = [];

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const edges = await loadEdges(frontier);
    const next: string[] = [];

    for (const edge of edges) {
      allEdges.push(edge);
      for (const id of [edge.personAId, edge.personBId]) {
        if (!seen.has(id)) {
          seen.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  const people = await loadPeople([...seen]);

  // A living node may be named to whoever speaks for a node it is directly
  // linked to.
  const neighbourStewardIds = new Set<string>();
  for (const edge of allEdges) {
    if (ownIds.has(edge.personAId)) neighbourStewardIds.add(edge.personBId);
    if (ownIds.has(edge.personBId)) neighbourStewardIds.add(edge.personAId);
  }

  const refs = new Map<string, number>();
  const nodes: TreeNode[] = [];

  for (const id of seen) {
    const person = people.get(id);
    const ref = nodes.length;
    refs.set(id, ref);

    if (!person) {
      nodes.push({ visible: false, ref });
      continue;
    }

    if (!(await mayName(actor, person, neighbourStewardIds))) {
      nodes.push({ visible: false, ref });
      continue;
    }

    const display = await displayFor(person);
    nodes.push({
      visible: true,
      ref,
      personId: person.id,
      name: display.name,
      lifeStatus: person.lifeStatus,
      birthYear: person.birthYear,
      deathYear: person.deathYear,
      memorialSlug: display.slug,
    });
  }

  const edges: TreeEdge[] = [];
  const emitted = new Set<string>();
  for (const edge of allEdges) {
    const fromRef = refs.get(edge.personAId);
    const toRef = refs.get(edge.personBId);
    if (fromRef === undefined || toRef === undefined) continue;

    const key = `${edge.kind}:${fromRef}:${toRef}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    edges.push({ kind: edge.kind, fromRef, toRef });
  }

  return ok({ rootRef: refs.get(rootPersonId) ?? 0, nodes, edges });
}

/**
 * The tree shown on a memorial page.
 *
 * Refuses before it reads anything if the caller may not see the memorial
 * itself, so this cannot become a side door into a private page.
 */
export async function readTreeForMemorial(
  actor: Actor,
  memorialId: string,
  options: { depth?: number } = {},
): Promise<Result<Tree, TreeError>> {
  const access = await resolveAccessById(memorialId, actor);
  if (!access.allowed) {
    return err("PERSON_NOT_FOUND");
  }

  const [memorial] = await db()
    .select({ deceasedPersonId: memorials.deceasedPersonId })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return err("PERSON_NOT_FOUND");
  }

  const [node] = await db()
    .select({ id: familyPeople.id })
    .from(familyPeople)
    .where(eq(familyPeople.deceasedPersonId, memorial.deceasedPersonId));

  if (!node) {
    return err("PERSON_NOT_FOUND");
  }

  return readTree(actor, node.id, options);
}
