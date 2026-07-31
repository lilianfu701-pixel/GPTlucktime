import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, familyPeople, memorials } from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import { memorialRoleFor } from "@/modules/memorials/membership";

export type AddPersonError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "NAME_REQUIRED"
  | "IMPLAUSIBLE_YEARS"
  | "ALREADY_IN_TREE"
  | "SELF_ALREADY_PLACED";

/** Nothing before this is a plausible birth year for a person in a tree. */
const EARLIEST_YEAR = 1000;

/**
 * Puts a memorial's subject into the family graph.
 *
 * The node points at the existing record rather than copying it. A name
 * corrected on the memorial is corrected in the tree, and a name the family
 * marked unsearchable stays unsearchable, because there is only ever one copy
 * of it.
 */
export async function addMemorialSubject(
  actor: Actor,
  memorialId: string,
  correlationId: string,
): Promise<Result<{ personId: string; created: boolean }, AddPersonError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  // Someone with no role must not learn whether this memorial exists.
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "manage_family_links" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const [memorial] = await db()
    .select({ deceasedPersonId: memorials.deceasedPersonId })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  const [existing] = await db()
    .select({ id: familyPeople.id })
    .from(familyPeople)
    .where(eq(familyPeople.deceasedPersonId, memorial.deceasedPersonId));

  // Two relatives adding the same grandmother must land on one node, or the
  // graph splits and neither half can see the other.
  if (existing) {
    return ok({ personId: existing.id, created: false });
  }

  const [row] = await db()
    .insert(familyPeople)
    .values({
      deceasedPersonId: memorial.deceasedPersonId,
      lifeStatus: "deceased",
      createdByUserId: actor.userId,
    })
    .returning({ id: familyPeople.id });

  if (!row) {
    return err("MEMORIAL_NOT_FOUND");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "family.person_added",
    resourceType: "family_person",
    resourceId: row.id,
    newValue: { memorialId },
    correlationId,
  });

  return ok({ personId: row.id, created: true });
}

export type LivingRelativeInput = {
  displayName: string;
  birthYear?: number | undefined;
};

/**
 * Records a relative who has no memorial: usually someone still living.
 *
 * Deliberately thin. This person has not signed up and may not know the row
 * exists, so it holds a name and at most a year — enough to tell two cousins
 * apart and to make a tree readable, and not enough to be useful to anybody
 * for anything else. No contact details, no full dates, no notes.
 *
 * The row is not a claim that the person agrees with it. If they later join and
 * claim the node, `selfUserId` moves stewardship to them.
 */
export async function addLivingRelative(
  actor: Actor,
  input: LivingRelativeInput,
  correlationId: string,
): Promise<Result<{ personId: string }, AddPersonError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const name = input.displayName.trim();
  if (name.length === 0 || name.length > 200) {
    return err("NAME_REQUIRED");
  }

  if (input.birthYear !== undefined) {
    const thisYear = new Date().getUTCFullYear();
    if (input.birthYear < EARLIEST_YEAR || input.birthYear > thisYear) {
      return err("IMPLAUSIBLE_YEARS");
    }
  }

  const [row] = await db()
    .insert(familyPeople)
    .values({
      displayName: name,
      lifeStatus: "living",
      ...(input.birthYear !== undefined ? { birthYear: input.birthYear } : {}),
      createdByUserId: actor.userId,
    })
    .returning({ id: familyPeople.id });

  if (!row) {
    return err("NAME_REQUIRED");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "family.living_relative_added",
    resourceType: "family_person",
    resourceId: row.id,
    correlationId,
  });

  return ok({ personId: row.id });
}

/**
 * Puts the signed-in person into their own tree.
 *
 * Separate from `addLivingRelative` because it is the one living node that is
 * not somebody's account of another person. Only one per account: a second
 * would make "who speaks for this person" ambiguous in the one case where it
 * has to be certain.
 */
export async function placeSelf(
  actor: Actor,
  displayName: string,
  correlationId: string,
): Promise<Result<{ personId: string; created: boolean }, AddPersonError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const name = displayName.trim();
  if (name.length === 0 || name.length > 200) {
    return err("NAME_REQUIRED");
  }

  const [existing] = await db()
    .select({ id: familyPeople.id })
    .from(familyPeople)
    .where(eq(familyPeople.selfUserId, actor.userId));

  if (existing) {
    return ok({ personId: existing.id, created: false });
  }

  const [row] = await db()
    .insert(familyPeople)
    .values({
      displayName: name,
      lifeStatus: "living",
      selfUserId: actor.userId,
      createdByUserId: actor.userId,
    })
    .returning({ id: familyPeople.id });

  if (!row) {
    return err("SELF_ALREADY_PLACED");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "family.self_placed",
    resourceType: "family_person",
    resourceId: row.id,
    correlationId,
  });

  return ok({ personId: row.id, created: true });
}

/**
 * Lets a living person take over the node somebody else recorded for them.
 *
 * The claim is not verified here, and this function does not pretend it is. It
 * exists so that stewardship can move to the person a row is about; who is
 * allowed to call it is a question for the route, and a contested claim goes
 * through the same dispute process as a contested memorial.
 */
export async function claimNode(
  actor: Actor,
  personId: string,
  correlationId: string,
): Promise<Result<{ personId: string }, AddPersonError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [alreadyPlaced] = await db()
    .select({ id: familyPeople.id })
    .from(familyPeople)
    .where(eq(familyPeople.selfUserId, actor.userId));

  if (alreadyPlaced && alreadyPlaced.id !== personId) {
    return err("SELF_ALREADY_PLACED");
  }

  const claimed = await db()
    .update(familyPeople)
    .set({ selfUserId: actor.userId })
    .where(
      and(
        eq(familyPeople.id, personId),
        eq(familyPeople.lifeStatus, "living"),
        // A node somebody has already claimed is not available.
        isNull(familyPeople.selfUserId),
      ),
    )
    .returning({ id: familyPeople.id });

  if (claimed.length === 0) {
    return err("ALREADY_IN_TREE");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "family.node_claimed",
    resourceType: "family_person",
    resourceId: personId,
    correlationId,
  });

  return ok({ personId });
}
