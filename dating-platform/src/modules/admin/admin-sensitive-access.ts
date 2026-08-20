import { and, eq, gt, isNotNull, or } from "drizzle-orm";

import {
  adminApprovalRequests,
  adminAuditLogs,
  adminSafetyAccessGrants,
  legalWorkflowTasks,
  messages,
  moderationCases,
  moderationEvidence,
  reports,
  safetyAlerts,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import type { AdminActor, AdminRequestContext } from "./admin-service";
import { buildAuditRecord } from "./audit-service";
import { requirePermission } from "./permissions";

type AdminDatabase = typeof productionDatabase;
export type SensitiveWorkflowKind = "report" | "safety" | "legal" | "approved_grant";
export type SensitiveWorkflowTarget = {
  kind: SensitiveWorkflowKind; caseId: string; reportId: string; messageId?: string; evidenceId?: string;
};

export class DrizzleAdminSensitiveWorkflowResolver {
  constructor(private readonly database: AdminDatabase, private readonly auditHmacKey: string,
    private readonly clock: () => Date = () => new Date()) {}

  async authorize(actor: AdminActor, target: SensitiveWorkflowTarget) {
    requirePermission(actor.role, "messages.private.read");
    if (actor.role === "finance" || (!target.messageId && !target.evidenceId)) throw new Error("FORBIDDEN");
    const [linked] = await this.database.select({ assignedWorkerUserId: moderationCases.assignedWorkerUserId,
      reportMessageId: reports.messageId }).from(moderationCases).innerJoin(reports,
      eq(reports.id, moderationCases.reportId)).where(and(
      eq(moderationCases.id, target.caseId), eq(reports.id, target.reportId),
    )).limit(1);
    if (!linked || (target.messageId && linked.reportMessageId !== target.messageId)) throw new Error("FORBIDDEN");
    if (target.evidenceId) {
      const [evidence] = await this.database.select({ id: moderationEvidence.id }).from(moderationEvidence).where(and(
        eq(moderationEvidence.id, target.evidenceId), eq(moderationEvidence.caseId, target.caseId),
        eq(moderationEvidence.reportId, target.reportId),
      )).limit(1);
      if (!evidence) throw new Error("FORBIDDEN");
    }
    let permitted = target.kind === "report" && linked.assignedWorkerUserId === actor.userId;
    if (target.kind === "safety" && actor.role === "safety") {
      const [alert] = await this.database.select({ id: safetyAlerts.id }).from(safetyAlerts).where(and(
        eq(safetyAlerts.caseId, target.caseId), eq(safetyAlerts.designatedRole, "safety_specialist"),
        or(eq(safetyAlerts.status, "pending"), eq(safetyAlerts.status, "acknowledged")),
      )).limit(1);
      permitted = Boolean(alert);
    }
    if (target.kind === "legal" && actor.role === "super_admin") {
      const [task] = await this.database.select({ id: legalWorkflowTasks.id }).from(legalWorkflowTasks).where(and(
        eq(legalWorkflowTasks.caseId, target.caseId),
        or(eq(legalWorkflowTasks.status, "pending"), eq(legalWorkflowTasks.status, "in_progress")),
      )).limit(1);
      permitted = Boolean(task);
    }
    if (target.kind === "approved_grant") {
      const [grant] = await this.database.select({ id: adminSafetyAccessGrants.id })
        .from(adminSafetyAccessGrants).innerJoin(adminApprovalRequests,
          eq(adminApprovalRequests.id, adminSafetyAccessGrants.approvalRequestId)).where(and(
          eq(adminSafetyAccessGrants.actorUserId, actor.userId), eq(adminSafetyAccessGrants.caseId, target.caseId),
          eq(adminSafetyAccessGrants.reportId, target.reportId), gt(adminSafetyAccessGrants.expiresAt, this.clock()),
          eq(adminApprovalRequests.status, "executed"), isNotNull(adminApprovalRequests.executedAt),
          target.messageId ? eq(adminSafetyAccessGrants.messageId, target.messageId)
            : eq(adminSafetyAccessGrants.evidenceId, target.evidenceId!),
        )).limit(1);
      permitted = Boolean(grant);
    }
    if (!permitted) throw new Error("FORBIDDEN");
  }

  async readEvidenceMetadata(actor: AdminActor, target: SensitiveWorkflowTarget, reason: string,
    context: AdminRequestContext) {
    await this.authorize(actor, target);
    const rows = await this.database.select({ id: moderationEvidence.id,
      classification: moderationEvidence.classification, createdAt: moderationEvidence.createdAt,
    }).from(moderationEvidence).where(and(eq(moderationEvidence.caseId, target.caseId),
      eq(moderationEvidence.reportId, target.reportId),
      target.evidenceId ? eq(moderationEvidence.id, target.evidenceId) : undefined)).limit(25);
    await this.audit(actor, target, reason, context, { evidenceCount: rows.length });
    return rows;
  }

  async readMessageMetadata(actor: AdminActor, target: SensitiveWorkflowTarget, reason: string,
    context: AdminRequestContext) {
    await this.authorize(actor, target);
    const [row] = await this.database.select({ id: messages.id, conversationId: messages.conversationId,
      senderUserId: messages.senderUserId, sequence: messages.sequence, createdAt: messages.createdAt,
    }).from(messages).where(eq(messages.id, target.messageId!)).limit(1);
    if (!row) throw new Error("FORBIDDEN");
    await this.audit(actor, target, reason, context, { messageMetadataRead: true });
    return row;
  }

  private async audit(actor: AdminActor, target: SensitiveWorkflowTarget, reason: string,
    context: AdminRequestContext, after: unknown) {
    await this.database.insert(adminAuditLogs).values(buildAuditRecord({ actorUserId: actor.userId,
      permission: "messages.private.read", targetType: target.evidenceId ? "evidence" : "message",
      targetId: target.evidenceId ?? target.messageId!, before: {}, after, reason,
      requestId: context.requestId, ipAddress: context.ipAddress, ipHmacKey: this.auditHmacKey, createdAt: this.clock(),
    }));
  }
}
