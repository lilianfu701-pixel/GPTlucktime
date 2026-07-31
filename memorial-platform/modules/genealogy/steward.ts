import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { familyPeople, memorials } from "@/db/schema";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import { memorialRoleFor } from "@/modules/memorials/membership";

/**
 * Who speaks for a node.
 *
 * Every cross-family link needs a second yes, and this is what decides whose
 * yes it has to be.
 *
 * The answer is derived, never stored. For a node that points at a memorial it
 * comes from that memorial's membership, so a family who transfers ownership
 * transfers this too, and a former owner stops being able to confirm links
 * about their relative the moment they hand the memorial over. Storing a
 * steward column would leave that stale in exactly the situation where it
 * matters — a contested family.
 */
export type StewardDecision =
  | { kind: "memorial"; memorialId: string; allowed: boolean }
  /** A living placeholder, or a record with no memorial behind it. */
  | { kind: "creator"; allowed: boolean }
  /** The person themselves, in their own tree. */
  | { kind: "self"; allowed: boolean }
  | { kind: "unknown_person"; allowed: false };

export async function stewardshipOf(
  actor: Actor,
  personId: string,
): Promise<StewardDecision> {
  const [person] = await db()
    .select({
      id: familyPeople.id,
      deceasedPersonId: familyPeople.deceasedPersonId,
      createdByUserId: familyPeople.createdByUserId,
      selfUserId: familyPeople.selfUserId,
    })
    .from(familyPeople)
    .where(eq(familyPeople.id, personId));

  if (!person) {
    return { kind: "unknown_person", allowed: false };
  }

  // A living person who has claimed their own node outranks whoever typed it
  // in. Nobody else gets to answer questions about a living person's family on
  // their behalf once they are here to answer for themselves.
  if (person.selfUserId) {
    return { kind: "self", allowed: person.selfUserId === actor.userId };
  }

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

    if (memorial) {
      const role = actor.userId
        ? await memorialRoleFor(memorial.id, actor.userId)
        : null;

      return {
        kind: "memorial",
        memorialId: memorial.id,
        allowed:
          role !== null &&
          canOnMemorial({ actor, role, action: "manage_family_links" }),
      };
    }
    // The memorial is gone or being deleted. Fall through: the node still
    // exists in other people's trees, and whoever recorded it still speaks for
    // their own copy of that fact.
  }

  return {
    kind: "creator",
    allowed: person.createdByUserId === actor.userId,
  };
}

/** Convenience for the common question. */
export async function maySpeakFor(
  actor: Actor,
  personId: string,
): Promise<boolean> {
  return (await stewardshipOf(actor, personId)).allowed;
}
