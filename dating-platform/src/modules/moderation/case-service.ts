import { and, eq } from "drizzle-orm";

import {
  appeals,
  moderationActions,
  moderationAuditEvents,
  moderationCases,
  moderationEvidence,
  moderationEvidenceAccess,
  profiles,
  reports,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import { ModerationError } from "./report-service";

type ModerationDatabase = typeof productionDatabase;
export type ModerationActor = {
  userId: string;
  role: "user" | "admin" | "case_worker" | "safety_specialist" | "appeal_reviewer" | "legal_reviewer";
};
type CaseStatus = typeof moderationCases.$inferSelect["status"];
type AppealDecision = "upheld" | "overturned" | "modified";

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

  constructor(database: unknown, options: { clock?: () => Date } = {}) {
    this.database = database as ModerationDatabase;
    this.clock = options.clock ?? (() => new Date());
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
  }) {
    const reasonCode = validText(input.reasonCode, 80);
    const evidenceSummary = validText(input.evidenceSummary, 2000);
    const now = this.clock();
    const expiresAt = input.expiresAt;
    if (!reasonCode || !evidenceSummary || !(expiresAt instanceof Date)
      || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
      throw new ModerationError("INVALID_ACTION");
    }
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const current = await this.lockCase(tx, caseId);
      await this.authorizeCaseActor(tx, current, actor);
      if (current.status !== "under_review") throw new ModerationError("INVALID_ACTION");
      const [target] = await tx.select({ userId: reports.targetUserId }).from(reports)
        .where(eq(reports.id, current.reportId)).limit(1);
      if (!target || target.userId !== input.subjectUserId) throw new ModerationError("INVALID_ACTION");
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
      const status = input.actionType === "ban"
        ? "banned"
        : input.actionType === "suspend"
          ? "suspended"
          : input.actionType === "temporary_restriction"
            ? "restricted"
            : null;
      if (status) await tx.update(profiles).set({ status, updatedAt: now })
        .where(eq(profiles.userId, input.subjectUserId));
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
    });
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
  ) {
    const summary = validText(rawSummary, 2000);
    if (!summary || actor.role !== "appeal_reviewer") throw new ModerationError("INVALID_APPEAL");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const [appeal] = await tx.select().from(appeals).where(eq(appeals.id, appealId)).for("update").limit(1);
      if (!appeal || appeal.status !== "submitted") throw new ModerationError("INVALID_APPEAL");
      const review = await this.lockCase(tx, appeal.reviewCaseId);
      await this.authorizeCaseActor(tx, review, actor);
      if (review.status !== "under_review") throw new ModerationError("INVALID_APPEAL");
      const now = this.clock();
      const [updatedAppeal] = await tx.update(appeals).set({
        status: decision,
        finalDecisionSummary: summary,
        decidedByUserId: actor.userId,
        finalizedAt: now,
      }).where(and(eq(appeals.id, appeal.id), eq(appeals.status, "submitted"))).returning();
      await tx.update(moderationCases).set({
        status: "actioned",
        finalDecisionSummary: summary,
        finalizedAt: now,
        updatedAt: now,
      }).where(and(eq(moderationCases.id, review.id), eq(moderationCases.status, "under_review")));
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
    if (!purpose || !(["case_worker", "safety_specialist", "legal_reviewer"] as string[]).includes(actor.role)) {
      throw new ModerationError("FORBIDDEN");
    }
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const current = await this.lockCase(tx, caseId);
      const rows = await tx.select().from(moderationEvidence)
        .where(eq(moderationEvidence.caseId, current.id));
      const restricted = rows.some((row) => row.classification === "restricted_safety");
      if (restricted && !(["safety_specialist", "legal_reviewer"] as string[]).includes(actor.role)) {
        throw new ModerationError("FORBIDDEN");
      }
      if (rows.length > 0) await tx.insert(moderationEvidenceAccess).values(rows.map((row) => ({
        evidenceId: row.id,
        actorUserId: actor.userId,
        actorRole: actor.role as "case_worker" | "safety_specialist" | "legal_reviewer",
        purposeCode: purpose,
        accessedAt: this.clock(),
      })));
      return rows;
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
