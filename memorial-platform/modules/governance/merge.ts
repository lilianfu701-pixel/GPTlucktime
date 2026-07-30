import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  biographies,
  commemorations,
  duplicateCandidates,
  mediaAssets,
  memorialLocations,
  memorialMembers,
  memorialNames,
  memorialSlugRedirects,
  memorials,
  moderationActions,
  timelineEvents,
  tributes,
  visitorSubmissions,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canGovern } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";

export type MergeError =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "MEMORIAL_NOT_FOUND"
  | "SAME_MEMORIAL"
  | "ALREADY_MERGED"
  | "EMPTY_REASON";

export type MergeSummary = {
  primaryMemorialId: string;
  mergedMemorialId: string;
  movedNames: number;
  movedCommemorations: number;
  redirectedSlug: string;
};

/**
 * Joins a duplicate memorial into the one that will remain.
 *
 * Only a reviewer, only with a reason, and never automatically: doc 03
 * section 7 keeps this a human decision because it is irreversible in the ways
 * that matter to a family.
 *
 * Two properties the implementation is built around:
 *
 * Authorship survives. Every moved row keeps its `authorUserId`,
 * `actorUserId` or `uploadedByUserId`, so a tribute written by a cousin is
 * still theirs afterwards. Rewriting those to the surviving owner would quietly
 * reassign what people wrote about someone who died.
 *
 * The old address survives. A link a family sent to relatives years ago must
 * still work, so the merged memorial's slug is recorded as a redirect rather
 * than left to 404.
 */
export async function mergeDuplicateMemorials(
  actor: Actor,
  input: {
    primaryMemorialId: string;
    mergedMemorialId: string;
    caseId?: string | undefined;
    reason: string;
  },
  correlationId: string,
): Promise<Result<MergeSummary, MergeError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  if (!canGovern({ actor, action: "merge_duplicate" })) {
    return err("FORBIDDEN");
  }

  if (input.primaryMemorialId === input.mergedMemorialId) {
    return err("SAME_MEMORIAL");
  }

  if (input.reason.trim().length === 0) {
    return err("EMPTY_REASON");
  }

  const [primary] = await db()
    .select()
    .from(memorials)
    .where(eq(memorials.id, input.primaryMemorialId));
  const [secondary] = await db()
    .select()
    .from(memorials)
    .where(eq(memorials.id, input.mergedMemorialId));

  if (!primary || !secondary) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (secondary.status === "merged") {
    return err("ALREADY_MERGED");
  }

  return db().transaction(async (tx) => {
    // Names and locations move as records of the same person, and any name the
    // family marked unsearchable stays unsearchable: the flag travels with the
    // row rather than being recomputed.
    const movedNames = await tx
      .update(memorialNames)
      .set({ memorialId: input.primaryMemorialId })
      .where(eq(memorialNames.memorialId, input.mergedMemorialId))
      .returning({ id: memorialNames.id });

    await tx
      .update(memorialLocations)
      .set({ memorialId: input.primaryMemorialId })
      .where(eq(memorialLocations.memorialId, input.mergedMemorialId));

    // Content keeps its author.
    for (const table of [biographies, timelineEvents, tributes] as const) {
      await tx
        .update(table)
        .set({ memorialId: input.primaryMemorialId })
        .where(eq(table.memorialId, input.mergedMemorialId));
    }

    await tx
      .update(visitorSubmissions)
      .set({ memorialId: input.primaryMemorialId })
      .where(eq(visitorSubmissions.memorialId, input.mergedMemorialId));

    await tx
      .update(mediaAssets)
      .set({ memorialId: input.primaryMemorialId })
      .where(eq(mediaAssets.memorialId, input.mergedMemorialId));

    // Acts of remembrance move with their visitor attached. Someone who came to
    // one page has come to this person, whichever page they found.
    const movedCommemorations = await tx
      .update(commemorations)
      .set({ memorialId: input.primaryMemorialId })
      .where(eq(commemorations.memorialId, input.mergedMemorialId))
      .returning({ id: commemorations.id });

    // Members of the merged page keep access, unless they are already members
    // of the surviving one.
    const secondaryMembers = await tx
      .select()
      .from(memorialMembers)
      .where(eq(memorialMembers.memorialId, input.mergedMemorialId));

    for (const member of secondaryMembers) {
      if (member.userId === primary.ownerUserId) {
        continue;
      }
      await tx
        .insert(memorialMembers)
        .values({
          memorialId: input.primaryMemorialId,
          userId: member.userId,
          // The other page's owner becomes an administrator here: a memorial
          // has one owner, and demoting them to nothing would remove a family
          // member who had been managing their relative's page.
          role: member.role === "owner" ? "admin" : member.role,
          invitedBy: member.invitedBy,
          acceptedAt: member.acceptedAt,
        })
        .onConflictDoNothing();
    }

    // The old address keeps working.
    await tx
      .insert(memorialSlugRedirects)
      .values({
        slug: secondary.slug,
        memorialId: input.primaryMemorialId,
        reason: "merged_duplicate",
      })
      .onConflictDoNothing();

    await tx
      .update(memorials)
      .set({ status: "merged", mergedIntoMemorialId: input.primaryMemorialId })
      .where(eq(memorials.id, input.mergedMemorialId));

    await tx
      .update(duplicateCandidates)
      .set({
        status: "merged",
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
      })
      .where(eq(duplicateCandidates.memorialId, input.mergedMemorialId));

    await tx.insert(moderationActions).values({
      caseId: input.caseId ?? null,
      actorUserId: actor.userId,
      action: "merge_duplicate",
      resourceType: "memorial",
      resourceId: input.mergedMemorialId,
      oldValue: { status: secondary.status, slug: secondary.slug },
      newValue: {
        status: "merged",
        mergedInto: input.primaryMemorialId,
        movedNames: movedNames.length,
        movedCommemorations: movedCommemorations.length,
      },
      reason: input.reason,
      correlationId,
    });

    return ok({
      primaryMemorialId: input.primaryMemorialId,
      mergedMemorialId: input.mergedMemorialId,
      movedNames: movedNames.length,
      movedCommemorations: movedCommemorations.length,
      redirectedSlug: secondary.slug,
    });
  });
}

/** Where an old address now points, if it was merged away. */
export async function resolveSlugRedirect(
  slug: string,
): Promise<string | null> {
  const [row] = await db()
    .select({ memorialId: memorialSlugRedirects.memorialId })
    .from(memorialSlugRedirects)
    .where(eq(memorialSlugRedirects.slug, slug));

  return row?.memorialId ?? null;
}
