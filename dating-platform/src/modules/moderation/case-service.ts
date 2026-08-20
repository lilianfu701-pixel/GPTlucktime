import { and, eq, or, sql } from "drizzle-orm";

import {
  appeals,
  moderationActions,
  moderationAuditEvents,
  moderationCases,
  moderationEvidence,
  moderationEvidenceAccess,
  moderationMediaHolds,
  moderationContentQuarantines,
  reports,
  userRestrictions,
  users,
  conversations,
  realtimePairRevocations,
  safetyAlerts,
  legalWorkflowTasks,
  messages,
  profilePhotos,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import { ModerationError } from "./report-service";
import { verifyEvidenceIntegrity } from "./evidence-integrity";
import { verifyMediaHoldSnapshot } from "./media-hold-integrity";

type ModerationDatabase = typeof productionDatabase;
export type ModerationActor = {
  userId: string;
  role: "user" | "admin" | "case_worker" | "safety_specialist" | "appeal_reviewer" | "legal_reviewer";
};
type CaseStatus = typeof moderationCases.$inferSelect["status"];
type AppealDecision = "upheld" | "overturned" | "modified";
type EvidenceReaderRole = "case_worker" | "safety_specialist" | "legal_reviewer";
const INDEFINITE_REVIEW_EXPIRES_AT = new Date("9999-12-31T23:59:59.000Z");

const transitions: Record<string, readonly string[]> = {
  submitted: ["triaged"],
  triaged: ["under_review"],
  under_review: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
};

const validText = (value: string, max: number) => {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
};

export class DrizzleCaseService {
  private readonly database: ModerationDatabase;
  private readonly clock: () => Date;
  private readonly resolveEvidenceReaderRole: (userId: string) => Promise<EvidenceReaderRole | null>;

  constructor(database: unknown, options: {
    clock?: () => Date;
    resolveEvidenceReaderRole: (userId: string) => Promise<EvidenceReaderRole | null>;
  }) {
    this.database = database as ModerationDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.resolveEvidenceReaderRole = options.resolveEvidenceReaderRole;
  }

  async transition(
    caseId: string,
    actor: ModerationActor,
    nextStatus: CaseStatus,
    options: { finalDecisionSummary?: string } = {},
  ) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const current = await this.lockCase(tx, caseId);
      await this.authorizeCaseActor(tx, current, actor);
      if (!transitions[current.status]?.includes(nextStatus)) {
        throw new ModerationError("INVALID_CASE_TRANSITION");
      }
      const isFinal = (["actioned", "dismissed"] as string[]).includes(nextStatus);
      const finalDecisionSummary = options.finalDecisionSummary
        ? validText(options.finalDecisionSummary, 2000)
        : null;
      if (isFinal !== Boolean(finalDecisionSummary)) {
        throw new ModerationError("INVALID_CASE_TRANSITION");
      }
      const now = this.clock();
      const [updated] = await tx.update(moderationCases).set({
        status: nextStatus,
        assignedWorkerUserId: current.assignedWorkerUserId ?? actor.userId,
        finalDecisionSummary,
        finalizedAt: isFinal ? now : null,
        updatedAt: now,
      }).where(and(
        eq(moderationCases.id, current.id),
        eq(moderationCases.status, current.status),
      )).returning();
      if (!updated) throw new ModerationError("INVALID_CASE_TRANSITION");
      await tx.update(reports).set({
        publicStatus: isFinal ? "resolved" : "in_review",
        updatedAt: now,
      }).where(eq(reports.id, current.reportId));
      if (current.kind === "appeal" && nextStatus === "under_review") {
        await tx.update(appeals).set({ status: "under_review" }).where(and(
          eq(appeals.reviewCaseId, current.id),
          eq(appeals.status, "submitted"),
        ));
      }
      await tx.insert(moderationAuditEvents).values({
        caseId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        eventType: "case_status_changed",
        summary: { from: current.status, to: nextStatus },
        createdAt: now,
      });
      return updated;
    });
  }

  async recordAction(caseId: string, actor: ModerationActor, input: {
    subjectUserId: string;
    actionType: "warn" | "temporary_restriction" | "suspend" | "ban" | "quarantine_content" | "restore";
    reasonCode: string;
    evidenceSummary: string;
    expiryPolicy: "fixed" | "indefinite_review";
    expiresAt: Date | null;
    contentTarget?: { type: "profile" | "message" | "photo"; id: string };
  }) {
    return this.database.transaction((transaction) =>
      this.recordActionInTransaction(transaction, caseId, actor, input));
  }

  async recordActionInTransaction(database: unknown, caseId: string, actor: ModerationActor, input: {
    subjectUserId: string;
    actionType: "warn" | "temporary_restriction" | "suspend" | "ban" | "quarantine_content" | "restore";
    reasonCode: string;
    evidenceSummary: string;
    expiryPolicy: "fixed" | "indefinite_review";
    expiresAt: Date | null;
    contentTarget?: { type: "profile" | "message" | "photo"; id: string };
  }) {
    const reasonCode = validText(input.reasonCode, 80);
    const evidenceSummary = validText(input.evidenceSummary, 2000);
    const now = this.clock();
    const expiresAt = input.expiresAt;
    if (!reasonCode || !evidenceSummary || !(expiresAt instanceof Date)
      || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
      throw new ModerationError("INVALID_ACTION");
    }
    const isIndefiniteSentinel = expiresAt.getTime() === INDEFINITE_REVIEW_EXPIRES_AT.getTime();
    if ((input.expiryPolicy === "indefinite_review") !== isIndefiniteSentinel
      || (input.actionType === "temporary_restriction" && input.expiryPolicy !== "fixed")
      || (input.actionType === "ban" && input.expiryPolicy !== "indefinite_review")) {
      throw new ModerationError("INVALID_ACTION");
    }
    if ((input.actionType === "quarantine_content") !== Boolean(input.contentTarget)) {
      throw new ModerationError("INVALID_ACTION");
    }
      const tx = database as ModerationDatabase;
      const current = await this.lockCase(tx, caseId);
      await this.authorizeCaseActor(tx, current, actor);
      if (current.status !== "under_review") throw new ModerationError("INVALID_ACTION");
      const [target] = await tx.select({
        userId: reports.targetUserId,
        profileId: reports.targetProfileId,
        messageId: reports.messageId,
        conversationId: reports.conversationId,
      }).from(reports)
        .where(eq(reports.id, current.reportId)).limit(1);
      if (!target || target.userId !== input.subjectUserId) throw new ModerationError("INVALID_ACTION");
      if (input.actionType === "quarantine_content" && input.contentTarget) {
        let validTarget = input.contentTarget.type === "profile"
          && input.contentTarget.id === target.profileId;
        if (input.contentTarget.type === "photo") {
          const [photo] = await tx.select({ userId: profilePhotos.userId }).from(profilePhotos)
            .where(eq(profilePhotos.id, input.contentTarget.id)).limit(1);
          const evidence = await tx.select({ locator: moderationEvidence.locator }).from(moderationEvidence)
            .where(and(
              eq(moderationEvidence.caseId, caseId),
              eq(moderationEvidence.reportId, current.reportId),
            ));
          validTarget = photo?.userId === input.subjectUserId && evidence.some(({ locator }) =>
            locator.referenceType === "photo" && locator.referenceId === input.contentTarget?.id);
        }
        if (input.contentTarget.type === "message") {
          const [message] = await tx.select({
            senderUserId: messages.senderUserId,
            conversationId: messages.conversationId,
          }).from(messages).where(eq(messages.id, input.contentTarget.id)).limit(1);
          validTarget = target.messageId === input.contentTarget.id
            && message?.senderUserId === input.subjectUserId
            && message.conversationId === target.conversationId;
        }
        if (!validTarget) throw new ModerationError("INVALID_ACTION");
      }
      await tx.select({ id: users.id }).from(users).where(eq(users.id, input.subjectUserId)).for("update");
      const [created] = await tx.insert(moderationActions).values({
        caseId,
        subjectUserId: input.subjectUserId,
        actionType: input.actionType,
        reasonCode,
        evidenceSummary,
        operatorUserId: actor.userId,
        expiryPolicy: input.expiryPolicy,
        expiresAt,
        createdAt: now,
      }).returning();
      if ((["temporary_restriction", "suspend", "ban"] as string[]).includes(input.actionType)) {
        await tx.insert(userRestrictions).values({
          subjectUserId: input.subjectUserId,
          sourceCaseId: caseId,
          scope: "all_interactions",
          reasonCode,
          expiryPolicy: input.expiryPolicy,
          active: true,
          startsAt: now,
          expiresAt,
          revokedAt: null,
          createdAt: now,
        }).onConflictDoUpdate({
          target: [userRestrictions.sourceCaseId, userRestrictions.scope],
          set: {
            subjectUserId: input.subjectUserId,
            reasonCode,
            expiryPolicy: input.expiryPolicy,
            active: true,
            startsAt: now,
            expiresAt,
            revokedAt: null,
          },
        });
        const pairs = await tx.select({
          lowUserId: conversations.lowUserId,
          highUserId: conversations.highUserId,
        }).from(conversations).where(or(
          eq(conversations.lowUserId, input.subjectUserId),
          eq(conversations.highUserId, input.subjectUserId),
        ));
        for (const pair of pairs) await tx.insert(realtimePairRevocations).values({
          ...pair, version: 1, revokedBefore: now, updatedAt: now,
        }).onConflictDoUpdate({
          target: [realtimePairRevocations.lowUserId, realtimePairRevocations.highUserId],
          set: { version: sql`${realtimePairRevocations.version} + 1`, revokedBefore: now, updatedAt: now },
        });
      }
      if (input.actionType === "quarantine_content" && input.contentTarget) {
        await tx.insert(moderationContentQuarantines).values({
          caseId,
          reportId: current.reportId,
          contentType: input.contentTarget.type,
          contentId: input.contentTarget.id,
          reasonCode,
          startsAt: now,
          preserveUntil: expiresAt,
          createdAt: now,
        });
      }
      if (input.actionType === "restore") {
        await tx.update(userRestrictions).set({ active: false, revokedAt: now })
          .where(and(eq(userRestrictions.sourceCaseId, caseId), eq(userRestrictions.active, true)));
        await tx.update(moderationContentQuarantines).set({ active: false, releasedAt: now })
          .where(and(eq(moderationContentQuarantines.caseId, caseId), eq(moderationContentQuarantines.active, true)));
      }
      await tx.insert(moderationAuditEvents).values({
        caseId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        eventType: "action_recorded",
        summary: {
          actionId: created.id,
          actionType: input.actionType,
          reasonCode,
          expiryPolicy: input.expiryPolicy,
          expiresAt: expiresAt.toISOString(),
        },
        createdAt: now,
      });
      return created;
  }

  async createAppeal(appellantUserId: string, originalCaseId: string, rawStatement: string) {
    const statement = validText(rawStatement, 2000);
    if (!statement) throw new ModerationError("INVALID_APPEAL");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const original = await this.lockCase(tx, originalCaseId);
      if (original.kind !== "initial" || !(["actioned", "dismissed"] as string[]).includes(original.status)) {
        throw new ModerationError("INVALID_APPEAL");
      }
      const [report] = await tx.select({ targetUserId: reports.targetUserId }).from(reports)
        .where(eq(reports.id, original.reportId)).limit(1);
      if (!report || report.targetUserId !== appellantUserId) throw new ModerationError("FORBIDDEN");
      const now = this.clock();
      const [reviewCase] = await tx.insert(moderationCases).values({
        reportId: original.reportId,
        kind: "appeal",
        originalCaseId: original.id,
        status: "submitted",
        priority: original.priority,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const [appeal] = await tx.insert(appeals).values({
        appellantUserId,
        originalCaseId: original.id,
        reviewCaseId: reviewCase.id,
        statement,
        createdAt: now,
      }).returning();
      await tx.insert(moderationAuditEvents).values([
        {
          caseId: original.id,
          actorUserId: appellantUserId,
          actorRole: "system",
          eventType: "appeal_submitted",
          summary: { appealId: appeal.id, reviewCaseId: reviewCase.id },
          createdAt: now,
        },
        {
          caseId: reviewCase.id,
          actorRole: "system",
          eventType: "appeal_review_created",
          summary: { appealId: appeal.id, originalCaseId: original.id },
          createdAt: now,
        },
      ]);
      return appeal;
    });
  }

  async finalizeAppeal(
    appealId: string,
    actor: ModerationActor,
    decision: AppealDecision,
    rawSummary: string,
    projection?: { restrictionExpiresAt: Date },
  ) {
    const summary = validText(rawSummary, 2000);
    const modifiedExpiry = projection?.restrictionExpiresAt;
    if (!summary || actor.role !== "appeal_reviewer"
      || (decision === "modified") !== Boolean(modifiedExpiry)
      || (modifiedExpiry && (Number.isNaN(modifiedExpiry.getTime()) || modifiedExpiry <= this.clock()))) {
      throw new ModerationError("INVALID_APPEAL");
    }
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const [appeal] = await tx.select().from(appeals).where(eq(appeals.id, appealId)).for("update").limit(1);
      if (!appeal || appeal.status !== "under_review") throw new ModerationError("INVALID_APPEAL");
      const review = await this.lockCase(tx, appeal.reviewCaseId);
      await this.authorizeCaseActor(tx, review, actor);
      if (review.status !== "under_review") throw new ModerationError("INVALID_APPEAL");
      const now = this.clock();
      if (decision === "overturned") {
        await tx.update(userRestrictions).set({ active: false, revokedAt: now }).where(and(
          eq(userRestrictions.sourceCaseId, appeal.originalCaseId), eq(userRestrictions.active, true),
        ));
        await tx.update(moderationContentQuarantines).set({ active: false, releasedAt: now }).where(and(
          eq(moderationContentQuarantines.caseId, appeal.originalCaseId),
          eq(moderationContentQuarantines.active, true),
        ));
        await tx.insert(moderationAuditEvents).values({
          caseId: appeal.originalCaseId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          eventType: "appeal_enforcement_revoked",
          summary: { appealId: appeal.id, reviewCaseId: review.id },
          createdAt: now,
        });
      }
      if (decision === "modified" && modifiedExpiry) {
        const adjusted = await tx.update(userRestrictions).set({
          expiryPolicy: "fixed",
          expiresAt: modifiedExpiry,
        }).where(and(
          eq(userRestrictions.sourceCaseId, appeal.originalCaseId),
          eq(userRestrictions.active, true),
        )).returning({ id: userRestrictions.id });
        if (adjusted.length === 0) throw new ModerationError("INVALID_APPEAL");
        await tx.insert(moderationAuditEvents).values({
          caseId: appeal.originalCaseId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          eventType: "appeal_enforcement_modified",
          summary: {
            appealId: appeal.id,
            reviewCaseId: review.id,
            restrictionExpiresAt: modifiedExpiry.toISOString(),
          },
          createdAt: now,
        });
      }
      const [updatedAppeal] = await tx.update(appeals).set({
        status: decision,
        finalDecisionSummary: summary,
        decidedByUserId: actor.userId,
        finalizedAt: now,
      }).where(and(eq(appeals.id, appeal.id), eq(appeals.status, "under_review"))).returning();
      await tx.update(moderationCases).set({
        status: "actioned",
        finalDecisionSummary: summary,
        finalizedAt: now,
        updatedAt: now,
      }).where(and(eq(moderationCases.id, review.id), eq(moderationCases.status, "under_review")));
      await tx.update(reports).set({ publicStatus: "resolved", updatedAt: now })
        .where(eq(reports.id, review.reportId));
      await tx.insert(moderationAuditEvents).values({
        caseId: review.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        eventType: "appeal_finalized",
        summary: { appealId: appeal.id, decision },
        createdAt: now,
      });
      return updatedAppeal;
    });
  }

  async readEvidence(caseId: string, actor: ModerationActor, purposeCode: string) {
    const purpose = validText(purposeCode, 80);
    const trustedRole = await this.resolveEvidenceReaderRole(actor.userId);
    if (!purpose || !trustedRole || actor.role !== trustedRole) {
      throw new ModerationError("FORBIDDEN");
    }
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const current = await this.lockCase(tx, caseId);
      if (trustedRole === "case_worker" && current.assignedWorkerUserId !== actor.userId) {
        throw new ModerationError("FORBIDDEN");
      }
      if (trustedRole === "safety_specialist" && current.assignedWorkerUserId !== actor.userId) {
        const [designation] = await tx.select({ id: safetyAlerts.id }).from(safetyAlerts).where(and(
          eq(safetyAlerts.caseId, current.id), eq(safetyAlerts.designatedRole, "safety_specialist"),
        )).limit(1);
        if (!designation) throw new ModerationError("FORBIDDEN");
      }
      if (trustedRole === "legal_reviewer") {
        const [legalTask] = await tx.select({ id: legalWorkflowTasks.id }).from(legalWorkflowTasks)
          .where(eq(legalWorkflowTasks.caseId, current.id)).limit(1);
        if (!legalTask) throw new ModerationError("FORBIDDEN");
      }
      const joinedRows = await tx.select({
        evidence: moderationEvidence,
        targetSnapshot: reports.targetSnapshot,
        subjectUserId: reports.targetUserId,
      }).from(moderationEvidence).innerJoin(reports, and(
        eq(reports.id, moderationEvidence.reportId),
        eq(reports.id, current.reportId),
      )).where(eq(moderationEvidence.caseId, current.id));
      if (joinedRows.some((row) => !verifyEvidenceIntegrity({
        reportId: row.evidence.reportId,
        caseId: row.evidence.caseId,
        subjectUserId: row.subjectUserId,
        targetSnapshot: row.targetSnapshot,
        locator: row.evidence.locator,
        capturedAt: row.evidence.createdAt,
      }, row.evidence.integritySha256))) throw new ModerationError("EVIDENCE_NOT_AVAILABLE");
      const heldMedia = await tx.select().from(moderationMediaHolds).where(and(
        eq(moderationMediaHolds.caseId, current.id),
        eq(moderationMediaHolds.reportId, current.reportId),
        eq(moderationMediaHolds.active, true),
      ));
      if (heldMedia.some((hold) => !verifyMediaHoldSnapshot({
        reportId: hold.reportId,
        caseId: hold.caseId,
        subjectUserId: hold.subjectUserId,
        photoId: hold.photoId,
        objectKey: hold.objectKey,
        objectVersion: hold.objectVersion,
        preserveUntil: hold.preserveUntil,
      }, hold.snapshotSha256))) throw new ModerationError("EVIDENCE_NOT_AVAILABLE");
      const rows = joinedRows.map(({ evidence }) => evidence);
      const restricted = rows.some((row) => row.classification === "restricted_safety");
      if (restricted && trustedRole === "case_worker") {
        throw new ModerationError("FORBIDDEN");
      }
      if (rows.length > 0) await tx.insert(moderationEvidenceAccess).values(rows.map((row) => ({
        evidenceId: row.id,
        actorUserId: actor.userId,
        actorRole: trustedRole,
        purposeCode: purpose,
        accessedAt: this.clock(),
      })));
      return rows;
    });
  }

  async releaseMediaHolds(caseId: string, actor: ModerationActor, rawReason: string) {
    const reason = validText(rawReason, 500);
    const trustedRole = await this.resolveEvidenceReaderRole(actor.userId);
    if (!reason || actor.role !== "legal_reviewer" || trustedRole !== "legal_reviewer") {
      throw new ModerationError("FORBIDDEN");
    }
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const current = await this.lockCase(tx, caseId);
      const [legalTask] = await tx.select({ id: legalWorkflowTasks.id }).from(legalWorkflowTasks)
        .where(eq(legalWorkflowTasks.caseId, current.id)).for("update").limit(1);
      if (!legalTask) throw new ModerationError("FORBIDDEN");
      const now = this.clock();
      const released = await tx.update(moderationMediaHolds).set({
        active: false,
        releasedAt: now,
        releasedByUserId: actor.userId,
      }).where(and(
        eq(moderationMediaHolds.caseId, current.id),
        eq(moderationMediaHolds.active, true),
      )).returning({ id: moderationMediaHolds.id });
      await tx.update(legalWorkflowTasks).set({ status: "completed", completedAt: now })
        .where(eq(legalWorkflowTasks.id, legalTask.id));
      await tx.insert(moderationAuditEvents).values({
        caseId: current.id,
        actorUserId: actor.userId,
        actorRole: "legal_reviewer",
        eventType: "media_hold_released",
        summary: { releasedCount: released.length, reason },
        createdAt: now,
      });
      return { releasedCount: released.length };
    });
  }

  private async lockCase(database: ModerationDatabase, caseId: string) {
    const [current] = await database.select().from(moderationCases)
      .where(eq(moderationCases.id, caseId)).for("update").limit(1);
    if (!current) throw new ModerationError("FORBIDDEN");
    return current;
  }

  private async authorizeCaseActor(
    database: ModerationDatabase,
    current: typeof moderationCases.$inferSelect,
    actor: ModerationActor,
  ) {
    const roleAllowed = current.kind === "appeal"
      ? actor.role === "appeal_reviewer"
      : current.priority === "emergency"
        ? actor.role === "safety_specialist"
        : actor.role === "case_worker" || actor.role === "safety_specialist";
    if (!roleAllowed || (current.assignedWorkerUserId && current.assignedWorkerUserId !== actor.userId)) {
      throw new ModerationError("FORBIDDEN");
    }
    if (current.kind === "appeal" && current.originalCaseId) {
      const [original] = await database.select({ assignedWorkerUserId: moderationCases.assignedWorkerUserId })
        .from(moderationCases).where(eq(moderationCases.id, current.originalCaseId)).limit(1);
      if (original?.assignedWorkerUserId === actor.userId) throw new ModerationError("FORBIDDEN");
    }
  }
}
