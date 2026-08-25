import { and, desc, eq } from "drizzle-orm";

import {
  adminAuditLogs, adminUserActionVersions, appeals, mediaReviewJobs, mediaReviewResults,
  moderationActions, moderationAuditEvents, moderationCases, profilePhotoUploads, profilePhotos, reports,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import { buildAuditRecord, sanitizeAuditReason } from "@/modules/admin/audit-service";
import type { AdminActor, AdminRequestContext, AdminService } from "@/modules/admin/admin-service";

import { DrizzleCaseService, type ModerationActor } from "./case-service";

type Database = typeof productionDatabase;
const caseActor = (actor: AdminActor, appeal = false): ModerationActor => ({
  userId: actor.userId,
  role: appeal ? "appeal_reviewer" : actor.role === "safety" || actor.role === "super_admin"
    ? "safety_specialist" : "case_worker",
});

export class ModerationAcceptanceService {
  constructor(private readonly database: Database, private readonly cases: DrizzleCaseService,
    private readonly admin: AdminService, private readonly auditHmacKey: string,
    private readonly clock: () => Date = () => new Date()) {}

  transitionCase(actor: AdminActor, caseId: string,
    nextStatus: "triaged" | "under_review" | "actioned" | "dismissed",
    context: { finalDecisionSummary?: string }) {
    return this.cases.transition(caseId, caseActor(actor), nextStatus,
      context.finalDecisionSummary ? { finalDecisionSummary: context.finalDecisionSummary } : {});
  }

  restrictCase(actor: AdminActor, caseId: string, input: { subjectUserId: string; reason: string;
    durationHours: number; expectedVersion: number; idempotencyKey: string }, context: AdminRequestContext) {
    return this.admin.applyModerationRestriction(actor, input.subjectUserId, { ...input, caseId }, context);
  }

  finalizeAppeal(actor: AdminActor, appealId: string, decision: "upheld" | "overturned" | "modified",
    summary: string, context: { restrictionExpiresAt?: Date }) {
    return this.cases.finalizeAppeal(appealId, caseActor(actor, true), decision, summary,
      context.restrictionExpiresAt ? { restrictionExpiresAt: context.restrictionExpiresAt } : undefined);
  }

  async startAppealReview(actor: AdminActor, appealId: string) {
    const [appeal] = await this.database.select({ reviewCaseId: appeals.reviewCaseId, status: appeals.status })
      .from(appeals).where(eq(appeals.id, appealId)).limit(1);
    if (!appeal || appeal.status !== "submitted") throw new Error("ACTION_NOT_AVAILABLE");
    const reviewer = caseActor(actor, true);
    await this.cases.transition(appeal.reviewCaseId, reviewer, "triaged");
    return this.cases.transition(appeal.reviewCaseId, reviewer, "under_review");
  }

  async decideMedia(actor: AdminActor, jobId: string, decision: "approved" | "rejected", rawReason: string,
    context: AdminRequestContext & { idempotencyKey: string }) {
    const reason = sanitizeAuditReason(rawReason);
    const now = this.clock();
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [job] = await tx.select().from(mediaReviewJobs).where(eq(mediaReviewJobs.id, jobId)).for("update").limit(1);
      if (!job) throw new Error("ACTION_NOT_AVAILABLE");
      if (job.status === "completed") {
        const [existing] = await tx.select().from(mediaReviewResults).where(eq(mediaReviewResults.jobId, job.id))
          .orderBy(desc(mediaReviewResults.attempt)).limit(1);
        if (existing?.provider === "manual-admin" && existing.outcome === decision) {
          return { jobId, photoId: job.photoId, status: decision, replayed: true };
        }
        throw new Error("VERSION_CONFLICT");
      }
      if (job.status === "processing") throw new Error("VERSION_CONFLICT");
      const [photo] = await tx.select().from(profilePhotos).where(eq(profilePhotos.id, job.photoId)).for("update").limit(1);
      if (!photo || photo.moderationStatus !== "pending" || photo.userRemovedAt) throw new Error("ACTION_NOT_AVAILABLE");
      const attempt = job.attempts + 1;
      await tx.insert(mediaReviewResults).values({ jobId: job.id, photoId: photo.id, attempt,
        provider: "manual-admin", providerVersion: "v1", outcome: decision,
        reasonCode: decision === "rejected" ? "MANUAL_REJECTED" : null, createdAt: now });
      await tx.update(mediaReviewJobs).set({ status: "completed", attempts: attempt, leaseId: null,
        leaseExpiresAt: null, lastError: null, updatedAt: now }).where(and(
        eq(mediaReviewJobs.id, job.id), eq(mediaReviewJobs.status, job.status)));
      await tx.update(profilePhotos).set({ moderationStatus: decision,
        moderationReasonCode: decision === "rejected" ? "MANUAL_REJECTED" : null,
        reviewProvider: "manual-admin", reviewVersion: "v1", reviewedAt: now,
        cleanupDueAt: decision === "rejected" ? new Date(now.getTime() + 7 * 86_400_000) : null,
        updatedAt: now }).where(and(eq(profilePhotos.id, photo.id), eq(profilePhotos.moderationStatus, "pending")));
      if (decision === "rejected") await tx.update(profilePhotoUploads).set({ quotaSlot: null, updatedAt: now })
        .where(eq(profilePhotoUploads.completedPhotoId, photo.id));
      await tx.insert(adminAuditLogs).values(buildAuditRecord({ actorUserId: actor.userId,
        permission: "profile_media.decide", targetType: "media_review", targetId: job.id,
        before: { status: job.status, photoStatus: photo.moderationStatus },
        after: { status: "completed", photoStatus: decision }, reason, requestId: context.requestId,
        ipAddress: context.ipAddress, ipHmacKey: this.auditHmacKey, createdAt: now }));
      return { jobId, photoId: photo.id, status: decision, replayed: false };
    });
  }

  async listMemberAppeals(userId: string) {
    const rows = await this.database.select({ caseId: moderationCases.id, caseStatus: moderationCases.status,
      finalizedAt: moderationCases.finalizedAt, appealId: appeals.id, appealStatus: appeals.status,
      appealSummary: appeals.finalDecisionSummary }).from(moderationCases)
      .innerJoin(reports, and(eq(reports.id, moderationCases.reportId), eq(reports.targetUserId, userId)))
      .leftJoin(appeals, eq(appeals.originalCaseId, moderationCases.id))
      .where(eq(moderationCases.kind, "initial")).orderBy(desc(moderationCases.createdAt));
    return { cases: rows.map((row) => ({ originalCaseId: row.caseId, caseStatus: row.caseStatus,
      finalizedAt: row.finalizedAt?.toISOString() ?? null, appeal: row.appealId ? {
        id: row.appealId, status: row.appealStatus, finalDecisionSummary: row.appealSummary,
      } : null })) };
  }

  createAppeal(userId: string, originalCaseId: string, statement: string) {
    return this.cases.createAppeal(userId, originalCaseId, statement);
  }

  async getCaseDetail(caseId: string) {
    const [record] = await this.database.select({ id: moderationCases.id, kind: moderationCases.kind,
      status: moderationCases.status, priority: moderationCases.priority,
      subjectUserId: reports.targetUserId,
      reportId: reports.id, targetType: reports.targetType, reasonCode: reports.reasonCode,
      messageId: reports.messageId, createdAt: moderationCases.createdAt,
    }).from(moderationCases).innerJoin(reports, eq(reports.id, moderationCases.reportId))
      .where(eq(moderationCases.id, caseId)).limit(1);
    if (!record) throw new Error("ACTION_NOT_AVAILABLE");
    const [events, actions, versions] = await Promise.all([
      this.database.select({ id: moderationAuditEvents.id, actorRole: moderationAuditEvents.actorRole,
        eventType: moderationAuditEvents.eventType, summary: moderationAuditEvents.summary,
        createdAt: moderationAuditEvents.createdAt }).from(moderationAuditEvents)
        .where(eq(moderationAuditEvents.caseId, caseId)).orderBy(moderationAuditEvents.createdAt, moderationAuditEvents.id),
      this.database.select({ id: moderationActions.id, actionType: moderationActions.actionType,
        reasonCode: moderationActions.reasonCode, expiresAt: moderationActions.expiresAt,
        createdAt: moderationActions.createdAt }).from(moderationActions)
        .where(eq(moderationActions.caseId, caseId)).orderBy(moderationActions.createdAt, moderationActions.id),
      this.database.select({ version: adminUserActionVersions.version }).from(adminUserActionVersions)
        .where(eq(adminUserActionVersions.targetUserId, record.subjectUserId)).limit(1),
    ]);
    return { case: { ...record, createdAt: record.createdAt.toISOString(), expectedVersion: versions[0]?.version ?? 0 },
      actions: actions.map((item) => ({ ...item, expiresAt: item.expiresAt.toISOString(), createdAt: item.createdAt.toISOString() })),
      timeline: events.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })) };
  }
}
