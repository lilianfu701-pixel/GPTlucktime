import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  biographies,
  commemorationMessages,
  commemorations,
  contentTranslations,
  contentVersions,
  exportJobs,
  mediaAssets,
  memorialLocations,
  memorialNames,
  memorials,
  outboxEvents,
  timelineEvents,
  tributes,
  visitorSubmissions,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import { memorialRoleFor } from "./membership";

export type ExportError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "EXPORT_IN_PROGRESS";

/** Bumped when the shape changes, so an old archive stays readable. */
export const MANIFEST_VERSION = "1.0";

/** A download link is short-lived: an archive is everything a family wrote. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Asks for a copy of a memorial.
 *
 * Owners and administrators only, per doc 04 section 9. An editor can write a
 * biography without being entitled to walk away with every message anyone left.
 *
 * Returns 202-shaped work: the archive is built by a worker, because gathering
 * media for a memorial with hundreds of photographs is not something to do
 * inside a request.
 */
export async function requestExport(
  actor: Actor,
  memorialId: string,
  idempotencyKey: string,
  correlationId: string,
): Promise<Result<{ exportJobId: string; created: boolean }, ExportError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  // Someone with no role must not learn the memorial exists.
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "request_export" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const [existing] = await db()
    .select({ id: exportJobs.id })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.memorialId, memorialId),
        eq(exportJobs.idempotencyKey, idempotencyKey),
      ),
    );

  if (existing) {
    // A retry returns the job already running rather than starting a second one.
    return ok({ exportJobId: existing.id, created: false });
  }

  const created = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(exportJobs)
      .values({
        memorialId,
        requestedByUserId: actor.userId,
        status: "requested",
        idempotencyKey,
        manifestVersion: MANIFEST_VERSION,
      })
      .returning({ id: exportJobs.id });

    if (!row) {
      throw new Error("export job insert returned no row");
    }

    await tx.insert(outboxEvents).values({
      topic: "export.requested",
      aggregateId: memorialId,
      payload: { exportJobId: row.id, memorialId, correlationId },
    });

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.export_requested",
      resourceType: "memorial",
      resourceId: memorialId,
      newValue: { exportJobId: row.id },
      correlationId,
    });

    return row.id;
  });

  return ok({ exportJobId: created, created: true });
}

export type ExportManifest = {
  manifestVersion: string;
  generatedAt: string;
  memorial: {
    id: string;
    slug: string;
    visibility: string;
    names: { value: string; type: string; searchable: boolean }[];
    locations: { kind: string; country: string | null; city: string | null }[];
  };
  biography: { version: number; body: string; sourceLocale: string } | null;
  timeline: { occurredOn: string | null; body: string }[];
  tributes: { body: string; sourceLocale: string }[];
  visitorStories: { title: string | null; body: string }[];
  commemorations: { ritualVersionId: string; message: string | null; at: string }[];
  translations: {
    targetLocale: string;
    method: string;
    status: string;
    reviewed: boolean;
  }[];
  media: {
    displayFileName: string;
    contentType: string;
    bytes: number | null;
  }[];
};

/**
 * Builds the archive contents.
 *
 * What is included is what the family produced or received. What is excluded is
 * listed explicitly in doc 04 section 9, and each exclusion has a reason:
 *
 * - credentials, because an export is a file that gets emailed and forwarded;
 * - dispute evidence, because it belongs to a case rather than to a page, and
 *   someone else may have supplied it;
 * - blocked-user details, because handing a family a list of who was blocked
 *   turns a moderation decision into a target list;
 * - internal scores, because a duplicate-detection number is our working note,
 *   not a fact about anyone.
 *
 * Visitor material is included only where the family accepted it. A rejected
 * submission was refused, and an export is not a way to read it afterwards.
 *
 * Translations appear as metadata, not text: a machine draft nobody reviewed
 * should not travel out of the platform looking like part of the record.
 */
export async function buildManifest(
  memorialId: string,
): Promise<Result<ExportManifest, ExportError>> {
  const [memorial] = await db()
    .select({
      id: memorials.id,
      slug: memorials.slug,
      visibility: memorials.visibility,
    })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  const names = await db()
    .select({
      value: memorialNames.value,
      type: memorialNames.type,
      searchable: memorialNames.searchable,
    })
    .from(memorialNames)
    .where(eq(memorialNames.memorialId, memorialId));

  const locations = await db()
    .select({
      kind: memorialLocations.kind,
      country: memorialLocations.country,
      city: memorialLocations.city,
    })
    .from(memorialLocations)
    .where(eq(memorialLocations.memorialId, memorialId));

  const [biography] = await db()
    .select({
      version: contentVersions.version,
      body: contentVersions.body,
      sourceLocale: contentVersions.sourceLocale,
    })
    .from(biographies)
    .innerJoin(
      contentVersions,
      eq(contentVersions.id, biographies.publishedVersionId),
    )
    .where(eq(biographies.memorialId, memorialId));

  const timeline = await db()
    .select({
      occurredOn: timelineEvents.occurredOn,
      body: contentVersions.body,
    })
    .from(timelineEvents)
    .innerJoin(
      contentVersions,
      eq(contentVersions.id, timelineEvents.publishedVersionId),
    )
    .where(eq(timelineEvents.memorialId, memorialId));

  const tributeRows = await db()
    .select({
      body: contentVersions.body,
      sourceLocale: contentVersions.sourceLocale,
    })
    .from(tributes)
    .innerJoin(
      contentVersions,
      eq(contentVersions.id, tributes.publishedVersionId),
    )
    .where(eq(tributes.memorialId, memorialId));

  // Only what the family accepted.
  const stories = await db()
    .select({
      title: visitorSubmissions.title,
      body: visitorSubmissions.body,
    })
    .from(visitorSubmissions)
    .where(
      and(
        eq(visitorSubmissions.memorialId, memorialId),
        eq(visitorSubmissions.status, "published"),
      ),
    );

  const acts = await db()
    .select({
      ritualVersionId: commemorations.ritualVersionId,
      createdAt: commemorations.createdAt,
      message: commemorationMessages.body,
      messageStatus: commemorationMessages.moderationStatus,
    })
    .from(commemorations)
    .leftJoin(
      commemorationMessages,
      eq(commemorationMessages.commemorationId, commemorations.id),
    )
    .where(
      and(
        eq(commemorations.memorialId, memorialId),
        eq(commemorations.status, "visible"),
      ),
    );

  const translationRows = await db()
    .select({
      targetLocale: contentTranslations.targetLocale,
      method: contentTranslations.method,
      status: contentTranslations.status,
      reviewerUserId: contentTranslations.reviewerUserId,
    })
    .from(contentTranslations)
    .innerJoin(
      contentVersions,
      eq(contentVersions.id, contentTranslations.contentVersionId),
    )
    .innerJoin(biographies, eq(biographies.id, contentVersions.contentId))
    .where(eq(biographies.memorialId, memorialId));

  // A manifest of the media, not the bytes. The files travel alongside.
  const media = await db()
    .select({
      displayFileName: mediaAssets.displayFileName,
      contentType: mediaAssets.declaredContentType,
      bytes: mediaAssets.actualBytes,
    })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.memorialId, memorialId), eq(mediaAssets.status, "ready")),
    );

  return ok({
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    memorial: {
      id: memorial.id,
      slug: memorial.slug,
      visibility: memorial.visibility,
      names,
      locations,
    },
    biography: biography ?? null,
    timeline,
    tributes: tributeRows,
    visitorStories: stories,
    commemorations: acts.map((act) => ({
      ritualVersionId: act.ritualVersionId,
      // A message the family had not accepted is not part of their record.
      message: act.messageStatus === "visible" ? act.message : null,
      at: act.createdAt.toISOString(),
    })),
    translations: translationRows.map((row) => ({
      targetLocale: row.targetLocale,
      method: row.method,
      status: row.status,
      reviewed: row.reviewerUserId !== null,
    })),
    media,
  });
}

/** Marks an export ready and records where it can be fetched from. */
export async function completeExport(input: {
  exportJobId: string;
  objectKey: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();

  await db()
    .update(exportJobs)
    .set({
      status: "ready",
      objectKey: input.objectKey,
      completedAt: now,
      expiresAt: new Date(now.getTime() + EXPORT_TTL_MS),
    })
    .where(eq(exportJobs.id, input.exportJobId));
}
