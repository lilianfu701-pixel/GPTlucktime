import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  moderationActions,
  moderationCases,
  memorials,
  reports,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { normalizeEmail } from "@/modules/auth/normalize";
import { canGovern } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";

export type ReportCategory =
  | "identity_impersonation"
  | "false_death"
  | "privacy_violation"
  | "harassment_or_hate"
  | "violent_or_explicit"
  | "spam"
  | "copyright"
  | "religious_or_cultural_error"
  | "ownership_dispute"
  | "other_safety";

export type CaseStatus =
  | "open"
  | "triaged"
  | "investigating"
  | "resolved"
  | "dismissed"
  | "appealed";

export type ReportError = "INVALID_CONTACT" | "EMPTY_REPORT";

export type RestrictionError =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "CASE_NOT_FOUND"
  | "MEMORIAL_NOT_FOUND"
  | "ALREADY_RESOLVED"
  | "APPEAL_ALREADY_USED";

/**
 * Records a complaint.
 *
 * Open to anyone, signed in or not. Requiring an account would mean a person
 * who finds a memorial impersonating their relative has to register before they
 * can say so.
 *
 * The reporter learns nothing about the outcome from this call, and the report
 * has no effect on the memorial by itself. Doc 06 section 6 puts a reviewer
 * between a complaint and any action, so that a report cannot be used as a way
 * to take someone's page down.
 */
export async function submitReport(
  actor: Actor,
  input: {
    resourceType: "memorial" | "commemoration" | "visitor_submission" | "media";
    resourceId: string;
    category: ReportCategory;
    description?: string | undefined;
    contactEmail?: string | undefined;
  },
  context: { requestIpHash?: string | undefined },
): Promise<Result<{ reportId: string }, ReportError>> {
  const description = input.description?.trim();
  if (
    input.category === "other_safety" &&
    (!description || description.length === 0)
  ) {
    // "Something else" with nothing said is not actionable.
    return err("EMPTY_REPORT");
  }

  let contactEmail: string | null = null;
  if (input.contactEmail) {
    const normalized = normalizeEmail(input.contactEmail);
    if (!normalized.ok) {
      return err("INVALID_CONTACT");
    }
    contactEmail = normalized.value;
  }

  const [row] = await db()
    .insert(reports)
    .values({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      category: input.category,
      description: description ?? null,
      reporterUserId: actor.userId,
      contactEmail,
      status: "open",
      requestIpHash: context.requestIpHash ?? null,
    })
    .returning({ id: reports.id });

  if (!row) {
    throw new Error("report insert returned no row");
  }

  return ok({ reportId: row.id });
}

/** Opens a case, optionally attaching reports that describe the same problem. */
export async function openCase(
  actor: Actor,
  input: {
    memorialId?: string | undefined;
    kind: string;
    reportIds?: string[] | undefined;
  },
  correlationId: string,
): Promise<Result<{ caseId: string }, RestrictionError>> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  return db().transaction(async (tx) => {
    const [row] = await tx
      .insert(moderationCases)
      .values({
        memorialId: input.memorialId ?? null,
        kind: input.kind,
        status: "open",
        assignedReviewerId: actor.userId,
      })
      .returning({ id: moderationCases.id });

    if (!row) {
      throw new Error("case insert returned no row");
    }

    for (const reportId of input.reportIds ?? []) {
      await tx
        .update(reports)
        .set({ caseId: row.id, status: "triaged" })
        .where(eq(reports.id, reportId));
    }

    await tx.insert(moderationActions).values({
      caseId: row.id,
      actorUserId: actor.userId,
      action: "restore",
      resourceType: "moderation_case",
      resourceId: row.id,
      newValue: { status: "open", kind: input.kind },
      reason: "Case opened.",
      correlationId,
    });

    return ok({ caseId: row.id });
  });
}

export type Restriction =
  | "restrict_editing"
  | "restrict_interactions"
  | "temporarily_hide"
  | "freeze_ownership";

const RESTRICTION_COLUMN: Record<Restriction, "editingRestrictedAt" | "interactionsRestrictedAt" | "ownershipFrozenAt" | null> = {
  restrict_editing: "editingRestrictedAt",
  restrict_interactions: "interactionsRestrictedAt",
  freeze_ownership: "ownershipFrozenAt",
  temporarily_hide: null,
};

/**
 * Applies a hold to a memorial.
 *
 * A reason is required by the signature, not by convention. Doc 06 section 6
 * makes it part of the record, because the question a family asks afterwards is
 * why, and an action with no stated reason cannot be reviewed or appealed.
 */
export async function applyRestriction(
  actor: Actor,
  input: {
    memorialId: string;
    restriction: Restriction;
    caseId?: string | undefined;
    reason: string;
  },
  correlationId: string,
): Promise<Result<{ applied: Restriction }, RestrictionError>> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const [memorial] = await db()
    .select()
    .from(memorials)
    .where(eq(memorials.id, input.memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  const now = new Date();

  await db().transaction(async (tx) => {
    const column = RESTRICTION_COLUMN[input.restriction];

    if (column) {
      await tx
        .update(memorials)
        .set({ [column]: now })
        .where(eq(memorials.id, input.memorialId));
    } else {
      await tx
        .update(memorials)
        .set({ status: "hidden" })
        .where(eq(memorials.id, input.memorialId));
    }

    await tx.insert(moderationActions).values({
      caseId: input.caseId ?? null,
      actorUserId: actor.userId,
      action: input.restriction,
      resourceType: "memorial",
      resourceId: input.memorialId,
      oldValue: {
        status: memorial.status,
        editingRestrictedAt: memorial.editingRestrictedAt,
        interactionsRestrictedAt: memorial.interactionsRestrictedAt,
        ownershipFrozenAt: memorial.ownershipFrozenAt,
      },
      newValue: { restriction: input.restriction, appliedAt: now },
      reason: input.reason,
      correlationId,
    });
  });

  return ok({ applied: input.restriction });
}

/** Lifts every hold and returns a hidden memorial to view. */
export async function restoreMemorial(
  actor: Actor,
  input: { memorialId: string; caseId?: string | undefined; reason: string },
  correlationId: string,
): Promise<Result<{ restored: true }, RestrictionError>> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const [memorial] = await db()
    .select()
    .from(memorials)
    .where(eq(memorials.id, input.memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(memorials)
      .set({
        status: memorial.status === "hidden" ? "published" : memorial.status,
        editingRestrictedAt: null,
        interactionsRestrictedAt: null,
        ownershipFrozenAt: null,
      })
      .where(eq(memorials.id, input.memorialId));

    await tx.insert(moderationActions).values({
      caseId: input.caseId ?? null,
      actorUserId: actor.userId,
      action: "restore",
      resourceType: "memorial",
      resourceId: input.memorialId,
      oldValue: {
        status: memorial.status,
        editingRestrictedAt: memorial.editingRestrictedAt,
        interactionsRestrictedAt: memorial.interactionsRestrictedAt,
        ownershipFrozenAt: memorial.ownershipFrozenAt,
      },
      newValue: { restored: true },
      reason: input.reason,
      correlationId,
    });
  });

  return ok({ restored: true });
}

/** Moves a case through its lifecycle. */
export async function setCaseStatus(
  actor: Actor,
  input: { caseId: string; status: CaseStatus; resolution?: string | undefined },
  correlationId: string,
): Promise<Result<{ status: CaseStatus }, RestrictionError>> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const [existing] = await db()
    .select()
    .from(moderationCases)
    .where(eq(moderationCases.id, input.caseId));

  if (!existing) {
    return err("CASE_NOT_FOUND");
  }

  // Doc 06 section 7 allows one review. A second appeal on the same case is
  // refused rather than quietly ignored.
  if (input.status === "appealed") {
    if (existing.appealCount >= 1) {
      return err("APPEAL_ALREADY_USED");
    }
  }

  const resolved = input.status === "resolved" || input.status === "dismissed";

  await db().transaction(async (tx) => {
    await tx
      .update(moderationCases)
      .set({
        status: input.status,
        resolution: input.resolution ?? existing.resolution,
        resolvedAt: resolved ? new Date() : existing.resolvedAt,
        appealCount:
          input.status === "appealed"
            ? existing.appealCount + 1
            : existing.appealCount,
      })
      .where(eq(moderationCases.id, input.caseId));

    await tx.insert(moderationActions).values({
      caseId: input.caseId,
      actorUserId: actor.userId,
      action: "resolve_dispute",
      resourceType: "moderation_case",
      resourceId: input.caseId,
      oldValue: { status: existing.status },
      newValue: { status: input.status },
      reason: input.resolution ?? `Status changed to ${input.status}.`,
      correlationId,
    });
  });

  return ok({ status: input.status });
}

function requireReviewer(actor: Actor): Result<true, RestrictionError> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }
  if (!canGovern({ actor, action: "restrict_editing" })) {
    return err("FORBIDDEN");
  }
  return ok(true);
}
