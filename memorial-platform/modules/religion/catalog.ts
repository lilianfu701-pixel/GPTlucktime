import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  outboxEvents,
  ritualDefinitions,
  ritualSources,
  ritualTranslations,
  ritualVersions,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canGovern } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";

export type PublishError =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "VERSION_NOT_FOUND"
  | "ALREADY_PUBLISHED"
  | "RETIRED"
  | "NO_SOURCE"
  | "NO_APPLICABILITY_SCOPE"
  | "NO_REVIEWER"
  | "NO_HUMAN_REVIEWED_TRANSLATION";

export type DraftError =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "DEFINITION_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "CANNOT_EDIT_PUBLISHED";

/**
 * Creates the next draft revision of a ritual.
 *
 * Always a new row. Doc 05 section 6 forbids editing a published revision:
 * families adopt a specific version, and rewriting one underneath them would
 * change what their memorial offers without anyone asking them.
 */
export async function createDraftVersion(
  actor: Actor,
  input: {
    definitionId: string;
    appliesToReligionId?: string | undefined;
    appliesToDenominationId?: string | undefined;
    appliesToCultureId?: string | undefined;
    appliesToCountries?: string[] | undefined;
    outOfScopeNote?: string | undefined;
    allowAnonymous?: boolean | undefined;
    allowMessage?: boolean | undefined;
    suggestPreReview?: boolean | undefined;
    conflictTags?: string[] | undefined;
    calendarId?: string | undefined;
    anniversaryRule?: string | undefined;
  },
  correlationId: string,
): Promise<Result<{ versionId: string; version: number }, DraftError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  // Authoring catalogue content is a staff capability, not a family one.
  if (!canGovern({ actor, action: "resolve_dispute" })) {
    return err("FORBIDDEN");
  }

  const [definition] = await db()
    .select({ id: ritualDefinitions.id })
    .from(ritualDefinitions)
    .where(eq(ritualDefinitions.id, input.definitionId));

  if (!definition) {
    return err("DEFINITION_NOT_FOUND");
  }

  return db().transaction(async (tx) => {
    const [highest] = await tx
      .select({ max: sql<number | null>`max(${ritualVersions.version})` })
      .from(ritualVersions)
      .where(eq(ritualVersions.definitionId, input.definitionId));

    const version = (highest?.max ?? 0) + 1;

    const [created] = await tx
      .insert(ritualVersions)
      .values({
        definitionId: input.definitionId,
        version,
        status: "draft",
        appliesToReligionId: input.appliesToReligionId ?? null,
        appliesToDenominationId: input.appliesToDenominationId ?? null,
        appliesToCultureId: input.appliesToCultureId ?? null,
        appliesToCountries: input.appliesToCountries ?? null,
        outOfScopeNote: input.outOfScopeNote ?? null,
        allowAnonymous: input.allowAnonymous ?? false,
        allowMessage: input.allowMessage ?? true,
        suggestPreReview: input.suggestPreReview ?? true,
        conflictTags: input.conflictTags ?? null,
        calendarId: input.calendarId ?? null,
        anniversaryRule: input.anniversaryRule ?? null,
        authoredByUserId: actor.userId,
      })
      .returning({ id: ritualVersions.id });

    if (!created) {
      throw new Error("ritual version insert returned no row");
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "ritual_version.drafted",
      resourceType: "ritual_version",
      resourceId: created.id,
      newValue: { definitionId: input.definitionId, version },
      correlationId,
    });

    return ok({ versionId: created.id, version });
  });
}

/** Records that a named person reviewed a draft. */
export async function markReviewed(
  actor: Actor,
  versionId: string,
  correlationId: string,
): Promise<Result<{ reviewed: true }, DraftError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  if (!canGovern({ actor, action: "resolve_dispute" })) {
    return err("FORBIDDEN");
  }

  const [version] = await db()
    .select({ id: ritualVersions.id, status: ritualVersions.status })
    .from(ritualVersions)
    .where(eq(ritualVersions.id, versionId));

  if (!version) {
    return err("VERSION_NOT_FOUND");
  }

  if (version.status === "published" || version.status === "retired") {
    return err("CANNOT_EDIT_PUBLISHED");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(ritualVersions)
      .set({
        status: "in_review",
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
      })
      .where(eq(ritualVersions.id, versionId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "ritual_version.reviewed",
      resourceType: "ritual_version",
      resourceId: versionId,
      correlationId,
    });
  });

  return ok({ reviewed: true });
}

/**
 * Publishes a reviewed revision.
 *
 * Every gate here is a refusal to make a claim about someone's faith that
 * nobody stands behind:
 *
 * - at least one source, or the rule is the platform's own assertion;
 * - an applicability scope, or it silently speaks for every believer;
 * - a named reviewer, so responsibility is attributable;
 * - a human-reviewed translation, so no reader is shown machine wording as
 *   though it were considered.
 *
 * Reserved for a super admin. Doc 05 section 6, doc 11 section 4.
 */
export async function publishRitualVersion(
  actor: Actor,
  versionId: string,
  correlationId: string,
): Promise<Result<{ published: true }, PublishError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  if (!canGovern({ actor, action: "publish_ritual_version" })) {
    return err("FORBIDDEN");
  }

  const [version] = await db()
    .select()
    .from(ritualVersions)
    .where(eq(ritualVersions.id, versionId));

  if (!version) {
    return err("VERSION_NOT_FOUND");
  }

  if (version.status === "published") {
    return err("ALREADY_PUBLISHED");
  }

  if (version.status === "retired") {
    return err("RETIRED");
  }

  const sources = await db()
    .select({ id: ritualSources.id })
    .from(ritualSources)
    .where(eq(ritualSources.ritualVersionId, versionId));

  if (sources.length === 0) {
    return err("NO_SOURCE");
  }

  const hasScope =
    version.appliesToReligionId !== null ||
    version.appliesToDenominationId !== null ||
    version.appliesToCultureId !== null ||
    (version.appliesToCountries?.length ?? 0) > 0;

  if (!hasScope) {
    return err("NO_APPLICABILITY_SCOPE");
  }

  if (!version.reviewedByUserId || !version.reviewedAt) {
    return err("NO_REVIEWER");
  }

  const humanTranslations = await db()
    .select({ id: ritualTranslations.id })
    .from(ritualTranslations)
    .where(
      and(
        eq(ritualTranslations.ritualVersionId, versionId),
        eq(ritualTranslations.method, "human"),
      ),
    );

  if (humanTranslations.length === 0) {
    return err("NO_HUMAN_REVIEWED_TRANSLATION");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(ritualVersions)
      .set({
        status: "published",
        publishedByUserId: actor.userId,
        publishedAt: new Date(),
      })
      .where(eq(ritualVersions.id, versionId));

    // Only human translations become readable; machine drafts stay drafts.
    await tx
      .update(ritualTranslations)
      .set({ status: "published" })
      .where(
        and(
          eq(ritualTranslations.ritualVersionId, versionId),
          eq(ritualTranslations.method, "human"),
        ),
      );

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "ritual_version.published",
      resourceType: "ritual_version",
      resourceId: versionId,
      newValue: { version: version.version, sources: sources.length },
      correlationId,
    });
  });

  return ok({ published: true });
}

/**
 * Withdraws a revision.
 *
 * The row stays, and memorials that adopted it are notified so an owner can
 * choose a replacement themselves. Doc 05 section 5 forbids swapping it out for
 * them.
 */
export async function retireRitualVersion(
  actor: Actor,
  versionId: string,
  reason: string,
  correlationId: string,
): Promise<Result<{ retired: true }, PublishError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  if (!canGovern({ actor, action: "publish_ritual_version" })) {
    return err("FORBIDDEN");
  }

  const [version] = await db()
    .select({ id: ritualVersions.id, status: ritualVersions.status })
    .from(ritualVersions)
    .where(eq(ritualVersions.id, versionId));

  if (!version) {
    return err("VERSION_NOT_FOUND");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(ritualVersions)
      .set({
        status: "retired",
        retiredAt: new Date(),
        retirementReason: reason,
      })
      .where(eq(ritualVersions.id, versionId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "ritual_version.retired",
      resourceType: "ritual_version",
      resourceId: versionId,
      newValue: { reason },
      correlationId,
    });

    await tx.insert(outboxEvents).values({
      topic: "notification.send",
      aggregateId: versionId,
      payload: {
        kind: "ritual_version.retired",
        ritualVersionId: versionId,
        correlationId,
      },
    });
  });

  return ok({ retired: true });
}

/** Revisions a family may adopt: published, never retired or draft. */
export async function adoptableVersions(definitionId: string): Promise<
  { id: string; version: number }[]
> {
  return db()
    .select({ id: ritualVersions.id, version: ritualVersions.version })
    .from(ritualVersions)
    .where(
      and(
        eq(ritualVersions.definitionId, definitionId),
        eq(ritualVersions.status, "published"),
      ),
    );
}

/** The reader-facing rendering, or null when this language has none reviewed. */
export async function publishedTranslation(
  versionId: string,
  locale: string,
): Promise<{ name: string; description: string; method: string } | null> {
  const [row] = await db()
    .select({
      name: ritualTranslations.name,
      description: ritualTranslations.description,
      method: ritualTranslations.method,
    })
    .from(ritualTranslations)
    .where(
      and(
        eq(ritualTranslations.ritualVersionId, versionId),
        eq(ritualTranslations.locale, locale),
        eq(ritualTranslations.status, "published"),
      ),
    );

  return row ?? null;
}
