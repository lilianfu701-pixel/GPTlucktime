import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, memorials, outboxEvents } from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import { memorialRoleFor } from "./membership";

export type Visibility = "public" | "unlisted" | "invite_only";

export type ChangePrivacyError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "OWNERSHIP_FROZEN"
  | "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED";

export type ChangePrivacyResult = {
  visibility: Visibility;
  searchEngineIndexable: boolean;
  changed: boolean;
};

export type PublishError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "OWNERSHIP_FROZEN"
  | "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED"
  /** Already published, or hidden, merged or awaiting deletion. */
  | "NOT_PUBLISHABLE";

/**
 * Publishes a memorial for the first time.
 *
 * A memorial is created as a draft so a family can write the life story, choose
 * the photographs and decide what visitors may offer before anyone else can
 * read any of it. This is the step where they say it is ready.
 *
 * Owner only, gated on `change_privacy` rather than `publish_content`. Those
 * are different decisions: an administrator may publish a biography onto a page
 * the family already opened, but deciding that the page itself becomes readable
 * is the same kind of choice as making it public, and the policy already keeps
 * that with the owner.
 */
export async function publishMemorial(
  actor: Actor,
  memorialId: string,
  input: { confirmPublicExposure?: boolean | undefined },
  correlationId: string,
): Promise<Result<{ slug: string; publishedAt: Date }, PublishError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [memorial] = await db()
    .select({
      slug: memorials.slug,
      status: memorials.status,
      visibility: memorials.visibility,
      searchEngineIndexable: memorials.searchEngineIndexable,
      ownershipFrozenAt: memorials.ownershipFrozenAt,
    })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (memorial.ownershipFrozenAt) {
    return err("OWNERSHIP_FROZEN");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "change_privacy" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  // Only a draft becomes published here. Restoring something hidden by a
  // reviewer, or undoing a deletion, are governance paths with their own
  // records; letting an owner reach those through this endpoint would route
  // around them.
  if (memorial.status !== "draft") {
    return err("NOT_PUBLISHABLE");
  }

  // Same rule as `changePrivacy`: a page becoming readable by the world is not
  // reversible in practice, because a search engine may keep a copy. The owner
  // says so rather than the request implying it.
  if (
    memorial.visibility === "public" &&
    memorial.searchEngineIndexable &&
    input.confirmPublicExposure !== true
  ) {
    return err("PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED");
  }

  const publishedAt = new Date();

  await db().transaction(async (tx) => {
    await tx
      .update(memorials)
      .set({ status: "published", publishedAt })
      .where(eq(memorials.id, memorialId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.published",
      resourceType: "memorial",
      resourceId: memorialId,
      oldValue: { status: memorial.status },
      newValue: { status: "published" },
      correlationId,
    });

    // One event, not two. `memorial.published` is registered to the search
    // handler, so emitting a `search.index` beside it would only index the
    // same memorial twice. Whether it belongs in results is not decided here
    // in any case: the search query filters on the live memorial row, so a
    // page the family kept private stays out however the index is built.
    await tx.insert(outboxEvents).values({
      topic: "memorial.published",
      aggregateId: memorialId,
      payload: { memorialId, correlationId },
    });
  });

  return ok({ slug: memorial.slug, publishedAt });
}

/**
 * Changes who can see a memorial.
 *
 * The database row is the truth, and it changes inside this transaction. Search
 * documents, caches and any external index are cleaned up afterwards through the
 * outbox. Access must never wait on that: a family who switches a memorial to
 * invite-only has to be protected on the very next request, not once a worker
 * gets round to it. See doc 02 section 5.
 */
export async function changePrivacy(
  actor: Actor,
  memorialId: string,
  input: {
    visibility: Visibility;
    searchEngineIndexable?: boolean | undefined;
    confirmPublicExposure?: boolean | undefined;
  },
  correlationId: string,
): Promise<Result<ChangePrivacyResult, ChangePrivacyError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [memorial] = await db()
    .select({
      id: memorials.id,
      visibility: memorials.visibility,
      searchEngineIndexable: memorials.searchEngineIndexable,
      status: memorials.status,
      ownershipFrozenAt: memorials.ownershipFrozenAt,
    })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  // Doc 06 section 7: while an ownership claim is open, the page cannot be made
  // private. Otherwise the owner under dispute could put it beyond reach of the
  // person contesting it, and of the reviewer looking into it.
  if (memorial.ownershipFrozenAt) {
    return err("OWNERSHIP_FROZEN");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);

  // Someone with no role must not learn that the memorial exists, so this is
  // the same answer as a missing one.
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "change_privacy" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const wasPrivate = memorial.visibility !== "public";
  const willBePublic = input.visibility === "public";
  const searchEngineIndexable =
    input.searchEngineIndexable ?? memorial.searchEngineIndexable;

  // Opening a memorial to the world is not reversible in practice: a search
  // engine may keep a copy for some time afterwards. Doc 01 section 3.3 makes
  // the owner say so explicitly rather than inferring consent from the request.
  if (wasPrivate && willBePublic && input.confirmPublicExposure !== true) {
    return err("PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED");
  }

  // Turning indexing on for an already public memorial is the same exposure.
  if (
    willBePublic &&
    searchEngineIndexable &&
    !memorial.searchEngineIndexable &&
    input.confirmPublicExposure !== true
  ) {
    return err("PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED");
  }

  const unchanged =
    memorial.visibility === input.visibility &&
    memorial.searchEngineIndexable === searchEngineIndexable;

  if (unchanged) {
    return ok({
      visibility: memorial.visibility,
      searchEngineIndexable: memorial.searchEngineIndexable,
      changed: false,
    });
  }

  await db().transaction(async (tx) => {
    await tx
      .update(memorials)
      .set({ visibility: input.visibility, searchEngineIndexable })
      .where(eq(memorials.id, memorialId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.privacy_changed",
      resourceType: "memorial",
      resourceId: memorialId,
      oldValue: {
        visibility: memorial.visibility,
        searchEngineIndexable: memorial.searchEngineIndexable,
      },
      newValue: { visibility: input.visibility, searchEngineIndexable },
      correlationId,
    });

    await tx.insert(outboxEvents).values({
      topic: "memorial.privacy_changed",
      aggregateId: memorialId,
      payload: {
        memorialId,
        from: memorial.visibility,
        to: input.visibility,
        correlationId,
      },
    });

    // A memorial that is no longer publicly searchable must leave the index.
    // The row above already refuses access; this only cleans up the copy.
    const shouldBeIndexed =
      input.visibility === "public" && memorial.status === "published";

    await tx.insert(outboxEvents).values({
      topic: shouldBeIndexed ? "search.index" : "search.remove",
      aggregateId: memorialId,
      payload: { memorialId, correlationId },
    });
  });

  return ok({
    visibility: input.visibility,
    searchEngineIndexable,
    changed: true,
  });
}
