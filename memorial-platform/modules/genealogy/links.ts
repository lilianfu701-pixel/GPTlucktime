import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, familyLinks, familyPeople } from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import type { Actor } from "@/modules/permissions/types";
import { maySpeakFor } from "./steward";

export type LinkError =
  | "AUTH_REQUIRED"
  | "PERSON_NOT_FOUND"
  | "NOT_YOUR_SIDE"
  | "SAME_PERSON"
  | "WOULD_CREATE_CYCLE"
  | "ALREADY_LINKED"
  | "LINK_NOT_FOUND"
  | "ALREADY_DECIDED";

export type ParentNature = "unspecified" | "birth" | "adoptive" | "step" | "foster";

/**
 * How deep the ancestry check walks.
 *
 * A bound rather than a belief about family size: without one, a graph that has
 * somehow acquired a cycle would make the check that exists to prevent cycles
 * run forever.
 */
const MAX_GENERATIONS = 60;

/**
 * Whether `candidateAncestorId` already sits above `personId`.
 *
 * Confirmed edges and proposed ones both count. Checking only confirmed edges
 * would let two proposals that are each fine on their own be accepted in either
 * order and leave somebody as their own great-grandparent.
 */
async function isAncestorOf(
  candidateAncestorId: string,
  personId: string,
): Promise<boolean> {
  const result = await db().execute<{ found: boolean }>(sql`
    with recursive ancestors(id, depth) as (
      select ${personId}::uuid, 0
      union all
      select l.person_a_id, a.depth + 1
        from family_links l
        join ancestors a on l.person_b_id = a.id
       where l.kind = 'parent'
         and l.status in ('proposed', 'confirmed')
         and a.depth < ${MAX_GENERATIONS}
    )
    select exists (
      select 1 from ancestors where id = ${candidateAncestorId}::uuid
    ) as found
  `);

  return result.rows[0]?.found === true;
}

/** Partner edges are stored once, lower id first. */
function canonicalPartnerPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export type ProposeLinkInput =
  | { kind: "parent"; parentId: string; childId: string; nature?: ParentNature }
  | { kind: "partner"; personId: string; partnerId: string };

/**
 * Proposes a relationship between two people.
 *
 * The proposer must speak for at least one of the two — you may say who your
 * own relatives are, and you may not rearrange a family you have nothing to do
 * with.
 *
 * If they speak for both, there is no second family to ask and the link is
 * confirmed immediately. That is the ordinary case of somebody building their
 * own tree, and making them confirm with themselves would be theatre.
 *
 * Otherwise it stays `proposed` until the other side accepts. Until then it is
 * not traversed, so proposing a link is not a way to read your way into a
 * family that has not agreed to know you.
 */
export async function proposeLink(
  actor: Actor,
  input: ProposeLinkInput,
  correlationId: string,
): Promise<
  Result<{ linkId: string; status: "proposed" | "confirmed" }, LinkError>
> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [personAId, personBId] =
    input.kind === "parent"
      ? [input.parentId, input.childId]
      : canonicalPartnerPair(input.personId, input.partnerId);

  if (personAId === personBId) {
    return err("SAME_PERSON");
  }

  const present = await db()
    .select({ id: familyPeople.id })
    .from(familyPeople)
    .where(inArray(familyPeople.id, [personAId, personBId]));

  if (present.length !== 2) {
    return err("PERSON_NOT_FOUND");
  }

  const speaksForA = await maySpeakFor(actor, personAId);
  const speaksForB = await maySpeakFor(actor, personBId);

  if (!speaksForA && !speaksForB) {
    return err("NOT_YOUR_SIDE");
  }

  if (input.kind === "parent") {
    // A person cannot be their own ancestor. The check runs on propose and
    // again on confirm, because the graph moves in between.
    if (await isAncestorOf(personBId, personAId)) {
      return err("WOULD_CREATE_CYCLE");
    }
  }

  const [existing] = await db()
    .select({ id: familyLinks.id, status: familyLinks.status })
    .from(familyLinks)
    .where(
      and(
        eq(familyLinks.kind, input.kind),
        eq(familyLinks.personAId, personAId),
        eq(familyLinks.personBId, personBId),
      ),
    );

  if (existing) {
    return err("ALREADY_LINKED");
  }

  // Both sides are already this person's to speak for, so there is nobody left
  // to ask.
  const bothSides = speaksForA && speaksForB;
  const now = new Date();

  const [row] = await db()
    .insert(familyLinks)
    .values({
      kind: input.kind,
      personAId,
      personBId,
      ...(input.kind === "parent" && input.nature
        ? { nature: input.nature }
        : {}),
      status: bothSides ? "confirmed" : "proposed",
      proposedByUserId: actor.userId,
      ...(bothSides
        ? { confirmedByUserId: actor.userId, confirmedAt: now, decidedAt: now }
        : {}),
    })
    .returning({ id: familyLinks.id });

  if (!row) {
    return err("ALREADY_LINKED");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: bothSides ? "family.link_confirmed" : "family.link_proposed",
    resourceType: "family_link",
    resourceId: row.id,
    newValue: { kind: input.kind, personAId, personBId },
    correlationId,
  });

  return ok({ linkId: row.id, status: bothSides ? "confirmed" : "proposed" });
}

/**
 * Accepts a proposed link.
 *
 * Must be somebody who speaks for the side that did not propose it. A proposer
 * confirming their own proposal would make the second yes meaningless, which is
 * the entire protection.
 */
export async function confirmLink(
  actor: Actor,
  linkId: string,
  correlationId: string,
): Promise<Result<{ linkId: string }, LinkError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [link] = await db()
    .select()
    .from(familyLinks)
    .where(eq(familyLinks.id, linkId));

  if (!link) {
    return err("LINK_NOT_FOUND");
  }

  if (link.status !== "proposed") {
    return err("ALREADY_DECIDED");
  }

  const speaksForA = await maySpeakFor(actor, link.personAId);
  const speaksForB = await maySpeakFor(actor, link.personBId);

  if (!speaksForA && !speaksForB) {
    // Not this person's family. They must not learn the proposal exists.
    return err("LINK_NOT_FOUND");
  }

  if (actor.userId === link.proposedByUserId) {
    return err("NOT_YOUR_SIDE");
  }

  // The graph may have moved since the proposal.
  if (link.kind === "parent" && (await isAncestorOf(link.personBId, link.personAId))) {
    return err("WOULD_CREATE_CYCLE");
  }

  const now = new Date();
  const updated = await db()
    .update(familyLinks)
    .set({
      status: "confirmed",
      confirmedByUserId: actor.userId,
      confirmedAt: now,
      decidedAt: now,
    })
    .where(and(eq(familyLinks.id, linkId), eq(familyLinks.status, "proposed")))
    .returning({ id: familyLinks.id });

  if (updated.length === 0) {
    // Somebody decided it between the read and the write.
    return err("ALREADY_DECIDED");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "family.link_confirmed",
    resourceType: "family_link",
    resourceId: linkId,
    correlationId,
  });

  return ok({ linkId });
}

/**
 * Refuses a proposed link, or withdraws one.
 *
 * The row is kept rather than deleted. A family who refused a connection once
 * should not have to refuse it again every week without anything showing that
 * they already answered.
 */
export async function rejectLink(
  actor: Actor,
  linkId: string,
  correlationId: string,
): Promise<Result<{ linkId: string }, LinkError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [link] = await db()
    .select()
    .from(familyLinks)
    .where(eq(familyLinks.id, linkId));

  if (!link) {
    return err("LINK_NOT_FOUND");
  }

  if (link.status !== "proposed") {
    return err("ALREADY_DECIDED");
  }

  const speaksForA = await maySpeakFor(actor, link.personAId);
  const speaksForB = await maySpeakFor(actor, link.personBId);

  if (!speaksForA && !speaksForB) {
    return err("LINK_NOT_FOUND");
  }

  const withdrawing = actor.userId === link.proposedByUserId;

  await db()
    .update(familyLinks)
    .set({
      status: withdrawing ? "withdrawn" : "rejected",
      decidedAt: new Date(),
    })
    .where(eq(familyLinks.id, linkId));

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: withdrawing ? "family.link_withdrawn" : "family.link_rejected",
    resourceType: "family_link",
    resourceId: linkId,
    correlationId,
  });

  return ok({ linkId });
}

/** Links waiting on this person's answer. */
export async function pendingForActor(
  actor: Actor,
): Promise<{ linkId: string; kind: string; personAId: string; personBId: string }[]> {
  if (!actor.userId) {
    return [];
  }

  const proposed = await db()
    .select({
      linkId: familyLinks.id,
      kind: familyLinks.kind,
      personAId: familyLinks.personAId,
      personBId: familyLinks.personBId,
      proposedByUserId: familyLinks.proposedByUserId,
    })
    .from(familyLinks)
    .where(eq(familyLinks.status, "proposed"));

  const mine: {
    linkId: string;
    kind: string;
    personAId: string;
    personBId: string;
  }[] = [];

  for (const link of proposed) {
    if (link.proposedByUserId === actor.userId) continue;
    if (
      (await maySpeakFor(actor, link.personAId)) ||
      (await maySpeakFor(actor, link.personBId))
    ) {
      mine.push({
        linkId: link.linkId,
        kind: link.kind,
        personAId: link.personAId,
        personBId: link.personBId,
      });
    }
  }

  return mine;
}

/**
 * Siblings, worked out rather than stored.
 *
 * Two people are siblings here if they share a confirmed parent. Storing the
 * relationship instead would let it disagree with the parent edges around it,
 * and a tree that contradicts itself makes every other edge in it suspect.
 */
export async function siblingsOf(personId: string): Promise<string[]> {
  const result = await db().execute<{ sibling_id: string }>(sql`
    select distinct other.person_b_id as sibling_id
      from family_links mine
      join family_links other
        on other.person_a_id = mine.person_a_id
       and other.kind = 'parent'
       and other.status = 'confirmed'
     where mine.kind = 'parent'
       and mine.status = 'confirmed'
       and mine.person_b_id = ${personId}::uuid
       and other.person_b_id <> ${personId}::uuid
  `);

  return result.rows.map((row) => row.sibling_id);
}

/** Confirmed immediate relatives, without any privacy filtering applied. */
export async function immediateLinks(personId: string): Promise<
  { linkId: string; kind: string; otherPersonId: string; role: "parent" | "child" | "partner" }[]
> {
  const rows = await db()
    .select({
      linkId: familyLinks.id,
      kind: familyLinks.kind,
      personAId: familyLinks.personAId,
      personBId: familyLinks.personBId,
    })
    .from(familyLinks)
    .where(
      and(
        eq(familyLinks.status, "confirmed"),
        or(
          eq(familyLinks.personAId, personId),
          eq(familyLinks.personBId, personId),
        ),
      ),
    );

  return rows.map((row) => {
    const isA = row.personAId === personId;
    const otherPersonId = isA ? row.personBId : row.personAId;
    const role =
      row.kind === "partner" ? "partner" : isA ? "child" : "parent";
    return { linkId: row.linkId, kind: row.kind, otherPersonId, role };
  });
}
