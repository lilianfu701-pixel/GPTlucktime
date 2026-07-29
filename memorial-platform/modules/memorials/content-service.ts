import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  biographies,
  contentVersions,
  visitorSubmissions,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import { memorialRoleFor } from "./membership";

export type ContentError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "CONTENT_NOT_FOUND"
  | "NOTHING_TO_PUBLISH"
  | "EMPTY_BODY";

export type ModerationError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "SUBMISSION_NOT_FOUND"
  | "ALREADY_MODERATED";

/**
 * Saves an edit to the life story.
 *
 * Appends a version; it never overwrites one. The public keeps seeing the
 * published version until the family publishes the new one, so an unfinished
 * edit is not visible on a page strangers are reading.
 */
export async function saveBiography(
  actor: Actor,
  memorialId: string,
  input: { title?: string | undefined; body: string; sourceLocale: string },
  correlationId: string,
): Promise<Result<{ biographyId: string; version: number }, ContentError>> {
  const authorized = await authorize(actor, memorialId, "edit_profile");
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const body = input.body.trim();
  if (body.length === 0) {
    return err("EMPTY_BODY");
  }

  return db().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(biographies)
      .where(eq(biographies.memorialId, memorialId))
      .for("update");

    const biographyId =
      existing?.id ??
      (
        await tx
          .insert(biographies)
          .values({ memorialId })
          .returning({ id: biographies.id })
      )[0]?.id;

    if (!biographyId) {
      throw new Error("biography insert returned no row");
    }

    const version = (existing?.latestVersion ?? 0) + 1;

    const [created] = await tx
      .insert(contentVersions)
      .values({
        contentType: "biography",
        contentId: biographyId,
        version,
        title: input.title ?? null,
        body,
        sourceLocale: input.sourceLocale,
        authorUserId: actor.userId,
      })
      .returning({ id: contentVersions.id });

    if (!created) {
      throw new Error("content version insert returned no row");
    }

    await tx
      .update(biographies)
      .set({ latestVersion: version, updatedAt: new Date() })
      .where(eq(biographies.id, biographyId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "biography.version_saved",
      resourceType: "biography",
      resourceId: biographyId,
      // The version number, not the prose: an audit trail is not a second copy
      // of everything a family wrote.
      newValue: { version, sourceLocale: input.sourceLocale },
      correlationId,
    });

    return ok({ biographyId, version });
  });
}

/**
 * Makes the latest saved version the one the public sees.
 *
 * Doc 06 section 3 gives editors this, alongside owners and administrators.
 * Writing the family's account of a life and publishing it are the same job.
 */
export async function publishBiography(
  actor: Actor,
  memorialId: string,
  correlationId: string,
): Promise<Result<{ publishedVersion: number }, ContentError>> {
  const authorized = await authorize(actor, memorialId, "publish_content");
  if (!authorized.ok) {
    return err(authorized.error);
  }

  return db().transaction(async (tx) => {
    const [biography] = await tx
      .select()
      .from(biographies)
      .where(eq(biographies.memorialId, memorialId))
      .for("update");

    if (!biography) {
      return err("CONTENT_NOT_FOUND");
    }

    if (biography.latestVersion === 0) {
      return err("NOTHING_TO_PUBLISH");
    }

    const [latest] = await tx
      .select({ id: contentVersions.id, version: contentVersions.version })
      .from(contentVersions)
      .where(
        and(
          eq(contentVersions.contentType, "biography"),
          eq(contentVersions.contentId, biography.id),
          eq(contentVersions.version, biography.latestVersion),
        ),
      );

    if (!latest) {
      return err("NOTHING_TO_PUBLISH");
    }

    await tx
      .update(biographies)
      .set({ publishedVersionId: latest.id, status: "published" })
      .where(eq(biographies.id, biography.id));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "biography.published",
      resourceType: "biography",
      resourceId: biography.id,
      newValue: { version: latest.version },
      correlationId,
    });

    return ok({ publishedVersion: latest.version });
  });
}

/** The version the public sees, or null when nothing has been published. */
export async function publishedBiography(memorialId: string): Promise<{
  versionId: string;
  version: number;
  title: string | null;
  body: string;
  sourceLocale: string;
} | null> {
  const [row] = await db()
    .select({
      versionId: contentVersions.id,
      version: contentVersions.version,
      title: contentVersions.title,
      body: contentVersions.body,
      sourceLocale: contentVersions.sourceLocale,
    })
    .from(biographies)
    .innerJoin(
      contentVersions,
      eq(contentVersions.id, biographies.publishedVersionId),
    )
    .where(
      and(eq(biographies.memorialId, memorialId), isNull(biographies.deletedAt)),
    );

  return row ?? null;
}

/**
 * Records something a visitor offered.
 *
 * It arrives as `pending_review` and stays out of every public query until
 * someone with the authority to moderate accepts it.
 */
export async function submitVisitorStory(
  actor: Actor,
  memorialId: string,
  input: { title?: string | undefined; body: string; sourceLocale: string },
  correlationId: string,
): Promise<Result<{ submissionId: string }, ContentError>> {
  const body = input.body.trim();
  if (body.length === 0) {
    return err("EMPTY_BODY");
  }

  const [submission] = await db()
    .insert(visitorSubmissions)
    .values({
      memorialId,
      submitterUserId: actor.userId,
      kind: "story",
      title: input.title ?? null,
      body,
      sourceLocale: input.sourceLocale,
      status: "pending_review",
    })
    .returning({ id: visitorSubmissions.id });

  if (!submission) {
    throw new Error("visitor submission insert returned no row");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "visitor_submission.created",
    resourceType: "visitor_submission",
    resourceId: submission.id,
    newValue: { memorialId, kind: "story" },
    correlationId,
  });

  return ok({ submissionId: submission.id });
}

export async function moderateSubmission(
  actor: Actor,
  submissionId: string,
  decision: "published" | "rejected",
  correlationId: string,
  note?: string,
): Promise<Result<{ status: "published" | "rejected" }, ModerationError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [submission] = await db()
    .select()
    .from(visitorSubmissions)
    .where(eq(visitorSubmissions.id, submissionId));

  if (!submission) {
    return err("SUBMISSION_NOT_FOUND");
  }

  const role = await memorialRoleFor(submission.memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "moderate_submission" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  if (submission.moderatedAt) {
    return err("ALREADY_MODERATED");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(visitorSubmissions)
      .set({
        status: decision,
        moderatedByUserId: actor.userId,
        moderatedAt: new Date(),
        moderationNote: note ?? null,
      })
      .where(eq(visitorSubmissions.id, submissionId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: `visitor_submission.${decision}`,
      resourceType: "visitor_submission",
      resourceId: submissionId,
      oldValue: { status: submission.status },
      newValue: { status: decision },
      correlationId,
    });
  });

  return ok({ status: decision });
}

/**
 * Visitor stories a public reader may see.
 *
 * The status condition is in the query itself rather than applied afterwards in
 * application code, so a later caller cannot forget it. See doc 04 section 7
 * for the same rule applied to search.
 */
export async function publicVisitorStories(memorialId: string): Promise<
  { id: string; title: string | null; body: string; sourceLocale: string }[]
> {
  return db()
    .select({
      id: visitorSubmissions.id,
      title: visitorSubmissions.title,
      body: visitorSubmissions.body,
      sourceLocale: visitorSubmissions.sourceLocale,
    })
    .from(visitorSubmissions)
    .where(
      and(
        eq(visitorSubmissions.memorialId, memorialId),
        eq(visitorSubmissions.status, "published"),
      ),
    );
}

/** Submissions still waiting for the family. */
export async function pendingVisitorStories(
  actor: Actor,
  memorialId: string,
): Promise<Result<{ id: string; body: string }[], ModerationError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "moderate_submission" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const rows = await db()
    .select({ id: visitorSubmissions.id, body: visitorSubmissions.body })
    .from(visitorSubmissions)
    .where(
      and(
        eq(visitorSubmissions.memorialId, memorialId),
        eq(visitorSubmissions.status, "pending_review"),
      ),
    );

  return ok(rows);
}

/** Counts the versions an item has, for tests and for the family's history view. */
export async function versionHistory(
  contentTypeValue: "biography" | "timeline_event" | "tribute",
  contentId: string,
): Promise<{ version: number; body: string; createdAt: Date }[]> {
  return db()
    .select({
      version: contentVersions.version,
      body: contentVersions.body,
      createdAt: contentVersions.createdAt,
    })
    .from(contentVersions)
    .where(
      and(
        eq(contentVersions.contentType, contentTypeValue),
        eq(contentVersions.contentId, contentId),
      ),
    )
    .orderBy(sql`${contentVersions.version} asc`);
}

async function authorize(
  actor: Actor,
  memorialId: string,
  action: "edit_profile" | "publish_content",
): Promise<Result<true, ContentError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  // Someone with no role must not learn the memorial exists.
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  return ok(true);
}
