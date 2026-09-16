import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { familyPeople } from "@/db/schema";
import { maskName } from "./mask";

/**
 * Register → recognise yourself in a seeded 族谱.
 *
 * When a lineage is seeded, its living members are planted as masked nodes: the
 * public sees "孔**", never the full name. This is the other half — when a
 * person registers and gives their name (and, tellingly, their 字辈), the system
 * quietly checks whether one of those masked nodes is them, and offers the claim.
 *
 * Deliberately conservative, like the deceased-side discovery: the name must
 * match exactly. A shared 字辈 or ancestral seat only raises confidence; it never
 * substitutes for the name, because a loose match would invite a stranger to
 * claim a living person's place. The claim itself still moves stewardship
 * through `claimNode` — nothing here decides it, it only surfaces the candidate.
 */

export type KinQuery = {
  fullName: string;
  /** The viewer's own 字辈, if they know it — the strongest corroborating clue. */
  generationName?: string | null;
};

export type KinCandidate = {
  personId: string;
  /** Masked, never the stored full name — the viewer confirms, we don't reveal. */
  maskedName: string;
  generationName: string | null;
  /** Whether the viewer's stated 字辈 matches this node's. */
  generationMatches: boolean;
};

/**
 * Whether a seeded node is a candidate for this query, given only the fields a
 * match may rest on. Pure, so the rule can be tested without a database.
 */
export function isKinCandidate(
  query: { fullName: string; generationName?: string | null },
  node: { displayName: string | null; generationName: string | null },
): boolean {
  const name = query.fullName.trim();
  if (!name || !node.displayName) return false;
  // Exact name is required. A stated 字辈, when given, must not contradict the
  // node's — a same-named person of a different generation is not this person.
  if (node.displayName.trim() !== name) return false;
  const wanted = query.generationName?.trim();
  if (wanted && node.generationName && node.generationName.trim() !== wanted) {
    return false;
  }
  return true;
}

/**
 * Unclaimed, masked, living 族谱 nodes that could be the signed-in person.
 *
 * Only nodes seeded by an import (`import_key` present), living, publicly
 * maskable and not yet claimed by anyone are considered — exactly the set a
 * descendant is meant to be able to recognise and take over.
 */
export async function discoverClaimableKin(
  query: KinQuery,
): Promise<KinCandidate[]> {
  const name = query.fullName.trim();
  if (!name) return [];

  const rows = await db()
    .select({
      id: familyPeople.id,
      displayName: familyPeople.displayName,
      generationName: familyPeople.generationName,
    })
    .from(familyPeople)
    .where(
      and(
        eq(familyPeople.displayName, name),
        eq(familyPeople.lifeStatus, "living"),
        eq(familyPeople.publicMasked, true),
        isNotNull(familyPeople.importKey),
        // Not already someone's own node.
        isNull(familyPeople.selfUserId),
      ),
    );

  const wanted = query.generationName?.trim();
  const candidates: KinCandidate[] = [];
  for (const row of rows) {
    if (!isKinCandidate(query, row)) continue;
    candidates.push({
      personId: row.id,
      maskedName: maskName(row.displayName ?? ""),
      generationName: row.generationName,
      generationMatches: Boolean(
        wanted && row.generationName && row.generationName.trim() === wanted,
      ),
    });
  }
  return candidates;
}
