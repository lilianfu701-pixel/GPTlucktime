import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { memorialMembers } from "@/db/schema";
import type { MemorialRole } from "@/modules/permissions/types";

/**
 * The one place a membership role is read.
 *
 * Deliberately single-sourced. An earlier draft had this lookup copied into
 * three modules, and one copy filtered by memorial without filtering by user —
 * which would have let any member of a memorial act with the first member's
 * role. Authorization inputs are not a good place for near-duplicates.
 */
export async function memorialRoleFor(
  memorialId: string,
  userId: string | null,
): Promise<MemorialRole | null> {
  if (!userId) {
    return null;
  }

  const [row] = await db()
    .select({ role: memorialMembers.role, revokedAt: memorialMembers.revokedAt })
    .from(memorialMembers)
    .where(
      and(
        eq(memorialMembers.memorialId, memorialId),
        eq(memorialMembers.userId, userId),
      ),
    );

  // A revoked membership is kept for the audit trail but grants nothing, and it
  // stops granting on the next request rather than when a cache expires.
  if (!row || row.revokedAt) {
    return null;
  }

  return row.role;
}
