import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { memorials } from "@/db/schema";
import type { Actor, MemorialRole } from "@/modules/permissions/types";
import { memorialRoleFor } from "./membership";

export type ViewerRole = MemorialRole | "public_visitor";

export type AccessDenial =
  /** Also the answer for a memorial that exists but must not be revealed. */
  | "NOT_FOUND"
  /** The viewer knows it exists — a lapsed invitation, say — but cannot enter. */
  | "INVITATION_REQUIRED"
  | "FORBIDDEN"
  /** Deleted and inside the recovery window. Only ever used where it existed publicly. */
  | "GONE"
  /**
   * Joined into another memorial. The caller looks up the redirect and sends the
   * visitor there: a link a family shared years ago must keep working.
   */
  | "MERGED";

export type AccessDecision =
  | { allowed: true; role: ViewerRole }
  | { allowed: false; reason: AccessDenial };

export type MemorialAccessFacts = {
  visibility: "public" | "unlisted" | "invite_only";
  status:
    | "draft"
    | "published"
    | "restricted"
    | "hidden"
    | "pending_deletion"
    | "merged";
};

/**
 * Decides whether a viewer may see a memorial.
 *
 * Pure, so the rules can be exercised exhaustively without a database. The
 * single most important line is the last: anyone who may not see an unlisted or
 * invite-only memorial is told it does not exist. Answering 403 would confirm
 * that a memorial for a named person exists on this platform, which is exactly
 * the fact a family chose to withhold.
 *
 * See doc 04 section 2 and doc 06 section 5.
 */
export function decideAccess(input: {
  memorial: MemorialAccessFacts | null;
  role: MemorialRole | null;
  actor: Actor;
}): AccessDecision {
  const { memorial, role } = input;

  if (!memorial) {
    return { allowed: false, reason: "NOT_FOUND" };
  }

  const isMember = role !== null && input.actor.userId !== null;

  // A merged memorial is not gone and not private: it is somewhere else. The
  // caller resolves the redirect, so an old link keeps working for everyone,
  // family and visitor alike.
  if (memorial.status === "merged") {
    return { allowed: false, reason: "MERGED" };
  }

  if (memorial.status === "pending_deletion") {
    // The family may still see it during the recovery window.
    if (isMember) {
      return { allowed: true, role };
    }
    // 410 tells a search engine and a returning visitor that a page they knew
    // about is gone. That is only safe to say when it was public; for anything
    // else, confirming it ever existed is the leak.
    return {
      allowed: false,
      reason: memorial.visibility === "public" ? "GONE" : "NOT_FOUND",
    };
  }

  // A draft is not a page yet, and a memorial hidden by a moderator is out of
  // public view while the case is open. Both stay visible to the family.
  if (memorial.status === "draft" || memorial.status === "hidden") {
    return isMember
      ? { allowed: true, role }
      : { allowed: false, reason: "NOT_FOUND" };
  }

  if (isMember) {
    return { allowed: true, role };
  }

  switch (memorial.visibility) {
    case "public":
      return { allowed: true, role: "public_visitor" };
    case "unlisted":
      // Holding the address is the only credential an unlisted memorial asks
      // for. It is kept out of search rather than behind a sign-in.
      return { allowed: true, role: "public_visitor" };
    case "invite_only":
      return { allowed: false, reason: "NOT_FOUND" };
  }
}

/** Looks up the facts the decision needs, then applies it. */
export async function resolveAccessById(
  memorialId: string,
  actor: Actor,
): Promise<AccessDecision> {
  const [memorial] = await db()
    .select({ visibility: memorials.visibility, status: memorials.status })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  return decideAccess({
    memorial: memorial ?? null,
    role: await memorialRoleFor(memorialId, actor.userId),
    actor,
  });
}

export async function resolveAccessBySlug(
  slug: string,
  actor: Actor,
): Promise<AccessDecision & { memorialId?: string }> {
  const [memorial] = await db()
    .select({
      id: memorials.id,
      visibility: memorials.visibility,
      status: memorials.status,
    })
    .from(memorials)
    .where(eq(memorials.slug, slug));

  if (!memorial) {
    return { allowed: false, reason: "NOT_FOUND" };
  }

  const decision = decideAccess({
    memorial,
    role: await memorialRoleFor(memorial.id, actor.userId),
    actor,
  });

  return { ...decision, memorialId: memorial.id };
}
