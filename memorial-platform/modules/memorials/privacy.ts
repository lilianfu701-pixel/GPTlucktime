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
  | "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED";

export type ChangePrivacyResult = {
  visibility: Visibility;
  searchEngineIndexable: boolean;
  changed: boolean;
};

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
    })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
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
