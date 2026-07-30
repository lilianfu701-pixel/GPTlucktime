import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  disputeEvidence,
  moderationCases,
  ownershipDisputes,
  reports,
  ritualVersions,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canGovern } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";

export type AdminQueryError = "AUTH_REQUIRED" | "FORBIDDEN";

/** Every queue is paginated. An unbounded staff query is still an export. */
export const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 25;

export type Page = { limit?: number | undefined; offset?: number | undefined };

function bounded(page: Page): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(page.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE),
    offset: Math.max(page.offset ?? 0, 0),
  };
}

function requireReviewer(actor: Actor): Result<true, AdminQueryError> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }
  if (!canGovern({ actor, action: "restrict_editing" })) {
    return err("FORBIDDEN");
  }
  return ok(true);
}

export type ReportSummary = {
  id: string;
  resourceType: string;
  resourceId: string;
  category: string;
  status: string;
  createdAt: Date;
  hasDescription: boolean;
};

/**
 * Complaints waiting to be looked at.
 *
 * The description and the reporter's address are not in the summary. A queue is
 * a list to work through, and a reviewer scanning thirty rows does not need
 * thirty people's contact details on screen; opening a case is where the detail
 * belongs.
 */
export async function reportQueue(
  actor: Actor,
  page: Page = {},
): Promise<Result<ReportSummary[], AdminQueryError>> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const { limit, offset } = bounded(page);

  const rows = await db()
    .select({
      id: reports.id,
      resourceType: reports.resourceType,
      resourceId: reports.resourceId,
      category: reports.category,
      status: reports.status,
      createdAt: reports.createdAt,
      description: reports.description,
    })
    .from(reports)
    .where(inArray(reports.status, ["open", "triaged", "investigating"]))
    .orderBy(desc(reports.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(
    rows.map((row) => ({
      id: row.id,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      category: row.category,
      status: row.status,
      createdAt: row.createdAt,
      hasDescription: Boolean(row.description),
    })),
  );
}

export type DisputeSummary = {
  id: string;
  memorialId: string;
  claimedRelationship: string;
  status: string;
  createdAt: Date;
  evidenceCount: number;
};

/**
 * Ownership claims waiting on a decision.
 *
 * The claimant's statement and every evidence object key are absent by design.
 * Doc 06 section 7 keeps evidence visible only to a reviewer who deliberately
 * opens it, and doc 06 section 5 makes that opening an audited action; a key
 * sitting in a list view would route around both.
 */
export async function disputeQueue(
  actor: Actor,
  page: Page = {},
): Promise<Result<DisputeSummary[], AdminQueryError>> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const { limit, offset } = bounded(page);

  const rows = await db()
    .select({
      id: ownershipDisputes.id,
      memorialId: ownershipDisputes.memorialId,
      claimedRelationship: ownershipDisputes.claimedRelationship,
      status: ownershipDisputes.status,
      createdAt: ownershipDisputes.createdAt,
      evidenceCount: sql<number>`(
        select count(*)::int from ${disputeEvidence}
        where ${disputeEvidence.disputeId} = ${ownershipDisputes.id}
      )`,
    })
    .from(ownershipDisputes)
    .where(inArray(ownershipDisputes.status, ["open", "investigating", "appealed"]))
    .orderBy(desc(ownershipDisputes.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(rows);
}

export type RitualReviewSummary = {
  id: string;
  definitionId: string;
  version: number;
  status: string;
  hasReviewer: boolean;
};

/** Ritual revisions waiting for review or publication. */
export async function ritualReviewQueue(
  actor: Actor,
  page: Page = {},
): Promise<Result<RitualReviewSummary[], AdminQueryError>> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const { limit, offset } = bounded(page);

  const rows = await db()
    .select({
      id: ritualVersions.id,
      definitionId: ritualVersions.definitionId,
      version: ritualVersions.version,
      status: ritualVersions.status,
      reviewedByUserId: ritualVersions.reviewedByUserId,
    })
    .from(ritualVersions)
    .where(inArray(ritualVersions.status, ["draft", "in_review"]))
    .orderBy(desc(ritualVersions.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(
    rows.map((row) => ({
      id: row.id,
      definitionId: row.definitionId,
      version: row.version,
      status: row.status,
      hasReviewer: row.reviewedByUserId !== null,
    })),
  );
}

export type QueueCounts = {
  openReports: number;
  openDisputes: number;
  ritualsAwaitingReview: number;
};

/**
 * Counts for the landing view.
 *
 * Called only after the caller has been established as staff. Doc 06 requires
 * the guard to run before the query, not after: a count is information, and
 * "how many complaints are open" is not something a stranger should learn from
 * a page that later returns 404.
 */
export async function queueCounts(
  actor: Actor,
): Promise<Result<QueueCounts, AdminQueryError>> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const [reportCount] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(reports)
    .where(eq(reports.status, "open"));

  const [disputeCount] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(ownershipDisputes)
    .where(eq(ownershipDisputes.status, "open"));

  const [ritualCount] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(ritualVersions)
    .where(inArray(ritualVersions.status, ["draft", "in_review"]));

  return ok({
    openReports: reportCount?.total ?? 0,
    openDisputes: disputeCount?.total ?? 0,
    ritualsAwaitingReview: ritualCount?.total ?? 0,
  });
}

/** Open cases assigned to nobody, so work does not silently stall. */
export async function unassignedCases(
  actor: Actor,
  page: Page = {},
): Promise<
  Result<{ id: string; kind: string; openedAt: Date }[], AdminQueryError>
> {
  const authorized = requireReviewer(actor);
  if (!authorized.ok) {
    return err(authorized.error);
  }

  const { limit, offset } = bounded(page);

  const rows = await db()
    .select({
      id: moderationCases.id,
      kind: moderationCases.kind,
      openedAt: moderationCases.openedAt,
    })
    .from(moderationCases)
    .where(
      and(
        eq(moderationCases.status, "open"),
        sql`${moderationCases.assignedReviewerId} is null`,
      ),
    )
    .orderBy(desc(moderationCases.openedAt))
    .limit(limit)
    .offset(offset);

  return ok(rows);
}
