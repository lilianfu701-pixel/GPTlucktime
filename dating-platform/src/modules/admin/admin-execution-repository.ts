import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, exists, gt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  adminApprovalRequests,
  adminApprovalDecisions,
  adminAuditLogs,
  adminBulkActionItems,
  adminExportJobs,
  adminOutboxEvents,
  adminRefundIntents,
  adminSafetyAccessGrants,
  adminSessions,
  adminRoleAssignments,
  billingPayments,
  billingOrders,
  billingPrices,
  moderationCases,
  moderationActions,
  moderationEvidence,
  reports,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import type { AdminApprovalExecutionRepository, ClaimedAdminApproval } from "./admin-approval-worker";
import type { AdminExportStorage } from "./admin-export-storage";
import type { GovernanceProjection } from "./admin-service";
import {
  bulkApprovalPayloadSchema as bulkPayload,
  canonicalAdminJson,
  exportApprovalPayloadSchema as exportPayload,
  priceApprovalPayloadSchema as pricePayload,
  refundApprovalPayloadSchema as refundPayload,
  safetyApprovalPayloadSchema as safetyPayload,
} from "./approval-contract";
import { redactAuditDiff, sanitizeAuditReason } from "./audit-service";

type AdminDatabase = typeof productionDatabase;
const EXECUTION_LEASE_MS = 30_000;
export type ManualRefundProvider = { createRefund(input: {
  providerPaymentId: string; amount: number; idempotencyKey: string;
}): Promise<{ providerRefundId: string }> };

export class DrizzleAdminApprovalExecutionRepository implements AdminApprovalExecutionRepository {
  constructor(private readonly database: AdminDatabase, private readonly governance: GovernanceProjection,
    private readonly refundProvider: ManualRefundProvider, private readonly exportStorage: AdminExportStorage) {}

  async claim(input: { limit: number; now: Date; leaseMs: number }) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const expired = await tx.select().from(adminApprovalRequests).where(and(
        or(eq(adminApprovalRequests.status, "pending"), eq(adminApprovalRequests.status, "approved")),
        lte(adminApprovalRequests.expiresAt, input.now),
      )).orderBy(adminApprovalRequests.expiresAt, adminApprovalRequests.id)
        .for("update", { skipLocked: true }).limit(input.limit);
      for (const request of expired) {
        await tx.update(adminApprovalRequests).set({ status: "expired", updatedAt: input.now })
          .where(eq(adminApprovalRequests.id, request.id));
        await this.recordTransition(tx, request, input.now, `admin.${request.action}.expired`,
          { status: request.status }, { status: "expired", reason: "approval_window_elapsed" });
      }
      const rows = await tx.select().from(adminApprovalRequests).where(and(or(
        and(eq(adminApprovalRequests.status, "approved"), gt(adminApprovalRequests.expiresAt, input.now),
          lte(adminApprovalRequests.availableAt, input.now)),
        and(eq(adminApprovalRequests.status, "executing"),
          lte(adminApprovalRequests.leaseExpiresAt, sql`statement_timestamp()`)),
      ), exists(tx.select({ id: adminApprovalDecisions.id }).from(adminApprovalDecisions).where(and(
        eq(adminApprovalDecisions.requestId, adminApprovalRequests.id),
        eq(adminApprovalDecisions.decision, "approved"),
      ))))).orderBy(adminApprovalRequests.availableAt, adminApprovalRequests.createdAt)
        .for("update", { skipLocked: true }).limit(input.limit);
      const claimed: ClaimedAdminApproval[] = [];
      for (const row of rows) {
        const leaseId = randomUUID();
        await tx.update(adminApprovalRequests).set({ status: "executing", leaseId,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), updatedAt: input.now })
          .where(eq(adminApprovalRequests.id, row.id));
        await this.recordTransition(tx, row, input.now,
          `admin.${row.action}.${row.status === "executing" ? "lease_recovered" : "executing"}`,
          { status: row.status }, { status: "executing", recovered: row.status === "executing" });
        claimed.push({ id: row.id, leaseId, action: row.action as ClaimedAdminApproval["action"] });
      }
      return claimed;
    });
  }

  async execute(claim: ClaimedAdminApproval, now: Date) {
    try {
      if (claim.action === "bulk_suspension") await this.executeBulk(claim, now);
      else if (claim.action === "sensitive_export") await this.executeExport(claim, now);
      else if (claim.action === "manual_refund") await this.executeRefund(claim, now);
      else if (claim.action === "payment_configuration") await this.executePriceConfiguration(claim, now);
      else await this.executeSafetyGrant(claim, now);
      return "executed" as const;
    } catch (error) {
      if (error instanceof Error && error.message === "ADMIN_EXPORT_READY_INTEGRITY") {
        return this.release(claim, now, "ADMIN_EXPORT_READY_INTEGRITY", true);
      }
      if (error instanceof Error && error.message === "ADMIN_BULK_MANUAL_REVIEW") {
        return this.release(claim, now, "ADMIN_BULK_ITEM_MANUAL_REVIEW", true);
      }
      if (error instanceof Error && error.message === "ADMIN_BULK_ITEMS_RETRY") {
        return this.release(claim, now, "ADMIN_BULK_ITEM_RETRY", false);
      }
      if (error instanceof Error && error.message === "INVALID_CLAIM") {
        return this.release(claim, now, "ADMIN_EXECUTION_LEASE_LOST", false);
      }
      if (error instanceof z.ZodError || (error instanceof Error && error.message.startsWith("INVALID_"))) {
        await this.release(claim, now, "INVALID_APPROVAL_PAYLOAD", true);
        return "manual_review" as const;
      }
      return this.release(claim, now,
        claim.action === "sensitive_export" ? "ADMIN_EXPORT_STORAGE_RETRY" : "ADMIN_EXECUTION_RETRY", false);
    }
  }

  private async loadClaim(database: AdminDatabase, claim: ClaimedAdminApproval) {
    const [request] = await database.select().from(adminApprovalRequests).where(and(
      eq(adminApprovalRequests.id, claim.id), eq(adminApprovalRequests.status, "executing"),
      eq(adminApprovalRequests.leaseId, claim.leaseId),
      gt(adminApprovalRequests.leaseExpiresAt, sql`statement_timestamp()`),
    )).for("update").limit(1);
    if (!request) throw new Error("INVALID_CLAIM");
    return request;
  }

  private async finalize(tx: AdminDatabase, request: typeof adminApprovalRequests.$inferSelect, now: Date, result: unknown) {
    const [updated] = await tx.update(adminApprovalRequests).set({ status: "executed", executedAt: now, updatedAt: now,
      leaseId: null, leaseExpiresAt: null, lastErrorCode: null }).where(and(
      eq(adminApprovalRequests.id, request.id), eq(adminApprovalRequests.status, "executing"),
      eq(adminApprovalRequests.leaseId, request.leaseId!),
      gt(adminApprovalRequests.leaseExpiresAt, sql`statement_timestamp()`),
    )).returning({ id: adminApprovalRequests.id });
    if (!updated) throw new Error("ADMIN_EXECUTION_LEASE_LOST");
    await this.recordTransition(tx, request, now, `admin.${request.action}.executed`,
      { status: "executing" }, { status: "executed", payloadHash: request.payloadHash, result });
  }

  private async recordTransition(tx: AdminDatabase, request: typeof adminApprovalRequests.$inferSelect, now: Date,
    eventType: string, before: unknown, after: unknown) {
    const [decision] = await tx.select({ approverUserId: adminApprovalDecisions.approverUserId })
      .from(adminApprovalDecisions).where(and(eq(adminApprovalDecisions.requestId, request.id),
        eq(adminApprovalDecisions.decision, "approved"))).limit(1);
    const actorUserId = decision?.approverUserId ?? request.requesterUserId;
    await tx.insert(adminOutboxEvents).values({ approvalRequestId: request.id, eventType,
      aggregateType: request.targetType, aggregateId: request.targetId,
      requestId: request.requestId, ipHash: request.ipHash,
      payload: { approvalRequestId: request.id, action: request.action, targetType: request.targetType,
        targetId: request.targetId, payloadHash: request.payloadHash,
        requestId: request.requestId, ipHash: request.ipHash,
        transition: redactAuditDiff(after) as Readonly<Record<string, unknown>> }, status: "pending", createdAt: now });
    await tx.insert(adminAuditLogs).values({ actorUserId,
      permission: request.approvalPermission, targetType: request.targetType, targetId: request.targetId,
      beforeDiff: redactAuditDiff(before), afterDiff: redactAuditDiff(after),
      reason: sanitizeAuditReason(request.reason), requestId: request.requestId, ipHash: request.ipHash, createdAt: now });
  }

  private async executeExport(claim: ClaimedAdminApproval, now: Date) {
    const prepared = await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const request = await this.loadClaim(tx, claim);
      const payload = exportPayload.parse(request.payload);
      await tx.insert(adminExportJobs).values({ approvalRequestId: request.id,
        requestedByUserId: request.requesterUserId, exportKind: payload.exportKind,
        scope: payload.scope, payloadHash: request.payloadHash, status: "queued", createdAt: now, updatedAt: now,
      }).onConflictDoNothing({ target: adminExportJobs.approvalRequestId });
      const [job] = await tx.select().from(adminExportJobs)
        .where(eq(adminExportJobs.approvalRequestId, request.id)).for("update").limit(1);
      if (!job) throw new Error("ADMIN_EXPORT_JOB_UNAVAILABLE");
      if (job.status === "ready") return { request, payload, job, alreadyReady: true as const };
      await tx.update(adminExportJobs).set({ status: "processing", leaseId: claim.leaseId,
        leaseExpiresAt: request.leaseExpiresAt, updatedAt: now }).where(eq(adminExportJobs.id, job.id));
      await this.recordTransition(tx, request, now, "admin.sensitive_export.processing",
        { exportStatus: job.status }, { exportStatus: "processing", attempts: job.attempts });
      return { request, payload, job, alreadyReady: false as const };
    });
    if (prepared.alreadyReady) {
      const body = await this.buildExportArtifact(prepared.payload, prepared.request.createdAt);
      const contentHash = createHash("sha256").update(body).digest("hex");
      const expectedKey = `admin-exports/${prepared.request.id}/${prepared.request.payloadHash}.v1.json`;
      if (prepared.job.objectKey !== expectedKey || prepared.job.artifactVersion !== 1
        || prepared.job.contentHash !== contentHash || prepared.job.sizeBytes !== body.byteLength
        || !prepared.job.expiresAt || !prepared.job.storageVersionId) throw new Error("ADMIN_EXPORT_READY_INVALID");
      try {
        await this.exportStorage.verifyEncrypted({ objectKey: expectedKey, body, contentHash,
          schemaVersion: 1, expiresAt: prepared.job.expiresAt }, prepared.job.storageVersionId);
      } catch { throw new Error("ADMIN_EXPORT_READY_INTEGRITY"); }
      return this.database.transaction(async (transaction) => {
        const tx = transaction as unknown as AdminDatabase;
        const request = await this.loadClaim(tx, claim);
        await this.finalize(tx, request, now, { exportStatus: "ready", contentHash: prepared.job.contentHash });
      });
    }
    const body = await this.buildExportArtifact(prepared.payload, prepared.request.createdAt);
    const contentHash = createHash("sha256").update(body).digest("hex");
    const objectKey = `admin-exports/${prepared.request.id}/${prepared.request.payloadHash}.v1.json`;
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
    const stored = await this.exportStorage.putEncrypted({ objectKey, body, contentHash, schemaVersion: 1, expiresAt });
    if (stored.sizeBytes !== body.byteLength || !stored.versionId) throw new Error("ADMIN_EXPORT_STORAGE_INVALID_RESULT");
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const request = await this.loadClaim(tx, claim);
      const [ready] = await tx.update(adminExportJobs).set({ status: "ready", objectKey,
        artifactVersion: 1, storageVersionId: stored.versionId, contentHash, sizeBytes: body.byteLength,
        expiresAt, attempts: prepared.job.attempts + 1, leaseId: null, leaseExpiresAt: null,
        lastErrorCode: null, updatedAt: now }).where(and(eq(adminExportJobs.id, prepared.job.id),
          eq(adminExportJobs.status, "processing"), eq(adminExportJobs.leaseId, claim.leaseId))).returning();
      if (!ready) throw new Error("ADMIN_EXPORT_LEASE_LOST");
      await this.recordTransition(tx, request, now, "admin.sensitive_export.ready",
        { exportStatus: "processing" }, { exportStatus: "ready", contentHash, sizeBytes: body.byteLength,
          artifactVersion: 1 });
      await this.finalize(tx, request, now, { exportStatus: "ready", contentHash, sizeBytes: body.byteLength,
        artifactVersion: 1 });
    });
  }

  private async buildExportArtifact(payload: ReturnType<typeof exportPayload.parse>, generatedAt: Date) {
    let records: unknown[];
    if (payload.exportKind === "billing_ledger") {
      records = (await this.database.select({ orderId: billingOrders.id, orderStatus: billingOrders.status,
        paymentId: billingPayments.id, amount: billingPayments.amount, currency: billingPayments.currency,
        paidAt: billingPayments.paidAt }).from(billingOrders)
        .leftJoin(billingPayments, eq(billingPayments.orderId, billingOrders.id))
        .where(eq(billingOrders.userId, payload.scope.subjectUserId))
        .orderBy(billingOrders.createdAt, billingOrders.id).limit(5_000))
        .map((row) => ({ ...row, paidAt: row.paidAt?.toISOString() ?? null }));
    } else {
      const caseId = payload.scope.caseId;
      records = (await this.database.select({ caseId: moderationCases.id, caseStatus: moderationCases.status,
        actionId: moderationActions.id, actionType: moderationActions.actionType,
        subjectUserId: moderationActions.subjectUserId, expiresAt: moderationActions.expiresAt,
        createdAt: moderationActions.createdAt }).from(moderationCases)
        .leftJoin(moderationActions, eq(moderationActions.caseId, moderationCases.id))
        .where(eq(moderationCases.id, caseId)).orderBy(moderationActions.createdAt, moderationActions.id).limit(5_000))
        .map((row) => ({ ...row, expiresAt: row.expiresAt?.toISOString() ?? null,
          createdAt: row.createdAt?.toISOString() ?? null }));
    }
    const serialized = canonicalAdminJson({ schema: "admin-sensitive-export", version: 1,
      kind: payload.exportKind, generatedAt: generatedAt.toISOString(), scope: payload.scope, records });
    return new TextEncoder().encode(serialized);
  }

  private async executeSafetyGrant(claim: ClaimedAdminApproval, now: Date) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const request = await this.loadClaim(tx, claim);
      const payload = safetyPayload.parse(request.payload);
      const expiresAt = new Date(payload.expiresAt);
      if (expiresAt <= now || expiresAt.getTime() - now.getTime() > 30 * 60_000) throw new Error("INVALID_GRANT_EXPIRY");
      const [linked] = await tx.select({ reportId: moderationCases.reportId, messageId: reports.messageId })
        .from(moderationCases).innerJoin(reports, eq(reports.id, moderationCases.reportId))
        .where(and(eq(moderationCases.id, payload.caseId), eq(reports.id, payload.reportId))).limit(1);
      if (!linked || (payload.messageId && linked.messageId !== payload.messageId)) throw new Error("INVALID_GRANT_LINK");
      if (payload.evidenceId) {
        const [evidence] = await tx.select({ id: moderationEvidence.id }).from(moderationEvidence).where(and(
          eq(moderationEvidence.id, payload.evidenceId), eq(moderationEvidence.caseId, payload.caseId),
          eq(moderationEvidence.reportId, payload.reportId),
        )).limit(1);
        if (!evidence) throw new Error("INVALID_GRANT_LINK");
      }
      await tx.insert(adminSafetyAccessGrants).values({ approvalRequestId: request.id,
        actorUserId: payload.actorUserId, caseId: payload.caseId, reportId: payload.reportId,
        evidenceId: payload.evidenceId ?? null, messageId: payload.messageId ?? null, expiresAt, createdAt: now,
      }).onConflictDoNothing({ target: adminSafetyAccessGrants.approvalRequestId });
      await this.finalize(tx, request, now, { grantExpiresAt: expiresAt.toISOString() });
    });
  }

  private async executePriceConfiguration(claim: ClaimedAdminApproval, now: Date) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const request = await this.loadClaim(tx, claim);
      const payload = pricePayload.parse(request.payload);
      const [current] = await tx.select({ version: billingPrices.version }).from(billingPrices).where(and(
        eq(billingPrices.planId, payload.planId), eq(billingPrices.countryCode, payload.countryCode),
        eq(billingPrices.currency, payload.currency),
      )).orderBy(desc(billingPrices.version)).for("update").limit(1);
      if ((current?.version ?? 0) !== payload.expectedVersion) throw new Error("INVALID_PRICE_VERSION");
      await tx.insert(billingPrices).values({ ...payload, version: payload.expectedVersion + 1,
        effectiveAt: new Date(payload.effectiveAt), expiresAt: null, active: true, provider: "stripe" });
      await this.finalize(tx, request, now, { priceVersion: payload.expectedVersion + 1 });
    });
  }

  private async executeRefund(claim: ClaimedAdminApproval, now: Date) {
    const intent = await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const request = await this.loadClaim(tx, claim);
      const payload = refundPayload.parse(request.payload);
      const [payment] = await tx.select({ id: billingPayments.id, providerPaymentId: billingPayments.providerPaymentId,
        amount: billingPayments.amount, currency: billingPayments.currency }).from(billingPayments)
        .where(eq(billingPayments.id, payload.paymentId)).for("update").limit(1);
      if (!payment?.providerPaymentId || payload.amount > payment.amount) throw new Error("INVALID_REFUND_PAYMENT");
      const idempotencyKey = `admin-refund:${request.id}:${request.payloadHash.slice(0, 24)}`;
      const [created] = await tx.insert(adminRefundIntents).values({ approvalRequestId: request.id,
        paymentId: payment.id, providerPaymentId: payment.providerPaymentId, amount: payload.amount,
        currency: payment.currency, idempotencyKey, createdAt: now, updatedAt: now,
      }).onConflictDoNothing({ target: adminRefundIntents.approvalRequestId }).returning();
      if (created) return created;
      const [existing] = await tx.select().from(adminRefundIntents)
        .where(eq(adminRefundIntents.approvalRequestId, request.id)).limit(1);
      if (!existing) throw new Error("REFUND_INTENT_UNAVAILABLE");
      return existing;
    });
    const providerResult = intent.providerRefundId ? { providerRefundId: intent.providerRefundId }
      : await this.refundProvider.createRefund({ providerPaymentId: intent.providerPaymentId,
        amount: intent.amount, idempotencyKey: intent.idempotencyKey });
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const [current] = await tx.select().from(adminRefundIntents)
        .where(eq(adminRefundIntents.id, intent.id)).for("update").limit(1);
      if (!current) throw new Error("REFUND_INTENT_UNAVAILABLE");
      if (current.providerRefundId && current.providerRefundId !== providerResult.providerRefundId) {
        throw new Error("INVALID_REFUND_PROVIDER_RESULT");
      }
      if (!current.providerRefundId) await tx.update(adminRefundIntents).set({ status: "provider_submitted",
        providerRefundId: providerResult.providerRefundId, attempts: current.attempts + 1, updatedAt: now })
        .where(eq(adminRefundIntents.id, intent.id));
    });
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const request = await this.loadClaim(tx, claim);
      await this.finalize(tx, request, now, { refundIntentStatus: "provider_submitted",
        providerRefundId: providerResult.providerRefundId });
    });
  }

  private async executeBulk(claim: ClaimedAdminApproval, now: Date) {
    const request = await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const row = await this.loadClaim(tx, claim);
      const payload = bulkPayload.parse(row.payload);
      await tx.insert(adminBulkActionItems).values(payload.targets.map((target) => ({ approvalRequestId: row.id,
        targetUserId: target.userId, caseId: target.caseId, expectedVersion: target.expectedVersion,
        createdAt: now, updatedAt: now }))).onConflictDoNothing();
      const [assignment] = await tx.select({ role: adminRoleAssignments.role }).from(adminSessions)
        .innerJoin(adminRoleAssignments, eq(adminRoleAssignments.id, adminSessions.roleAssignmentId))
        .where(and(eq(adminSessions.id, row.requesterAdminSessionId),
          eq(adminRoleAssignments.active, "active"))).limit(1);
      if (!assignment || !["safety", "operations", "super_admin"].includes(assignment.role)) {
        throw new Error("INVALID_REQUESTER_ROLE");
      }
      return { row, payload, requesterRole: assignment.role as "safety" | "operations" | "super_admin" };
    });
    let hasRetry = false;
    let hasManualReview = false;
    let executed = 0;
    for (const target of request.payload.targets) {
      const item = await this.database.transaction(async (transaction) => {
        const tx = transaction as unknown as AdminDatabase;
        await this.loadClaim(tx, claim);
        const renewalBase = Math.max(now.getTime(), Date.now());
        const [renewed] = await tx.update(adminApprovalRequests).set({
          leaseExpiresAt: new Date(renewalBase + EXECUTION_LEASE_MS), updatedAt: now,
        }).where(and(eq(adminApprovalRequests.id, claim.id), eq(adminApprovalRequests.status, "executing"),
          eq(adminApprovalRequests.leaseId, claim.leaseId),
          gt(adminApprovalRequests.leaseExpiresAt, sql`statement_timestamp()`)))
          .returning({ id: adminApprovalRequests.id });
        if (!renewed) throw new Error("INVALID_CLAIM");
        const [current] = await tx.select().from(adminBulkActionItems).where(and(
          eq(adminBulkActionItems.approvalRequestId, request.row.id),
          eq(adminBulkActionItems.targetUserId, target.userId),
        )).for("update").limit(1);
        if (!current) throw new Error("INVALID_BULK_ITEM");
        if (current.status === "executed" || current.status === "manual_review") return current;
        const [claimed] = await tx.update(adminBulkActionItems).set({ status: "claimed",
          attempts: current.attempts + 1, lastErrorCode: null, updatedAt: now }).where(and(
          eq(adminBulkActionItems.id, current.id), eq(adminBulkActionItems.status, current.status),
        )).returning();
        if (!claimed) throw new Error("INVALID_CLAIM");
        return claimed;
      });
      if (!item) throw new Error("INVALID_BULK_ITEM");
      if (item.status === "executed") { executed += 1; continue; }
      if (item.status === "manual_review") { hasManualReview = true; continue; }
      const attempts = item.attempts;
      try {
        const result = await this.governance.applyUserAction({ actorUserId: request.row.requesterUserId,
          actorRole: request.requesterRole,
          targetUserId: target.userId, action: "suspend", caseId: target.caseId,
          reason: request.payload.reasonCode, idempotencyKey: `bulk:${request.row.id}:${target.userId}`,
          expectedVersion: target.expectedVersion, durationHours: target.durationHours,
          context: { requestId: request.row.requestId, ipHash: request.row.ipHash },
        }) as { actionId?: unknown };
        const resultActionId = z.string().uuid().safeParse(result.actionId);
        if (!resultActionId.success) throw new Error("ADMIN_BULK_RESULT_INVALID");
        await this.database.transaction(async (transaction) => {
          const tx = transaction as unknown as AdminDatabase;
          await this.loadClaim(tx, claim);
          const [updated] = await tx.update(adminBulkActionItems).set({ status: "executed",
            resultActionId: resultActionId.data, lastErrorCode: null, updatedAt: now })
            .where(and(eq(adminBulkActionItems.id, item.id), eq(adminBulkActionItems.status, "claimed"))).returning();
          if (!updated) throw new Error("INVALID_CLAIM");
          await this.recordTransition(tx, request.row, now, "admin.bulk_suspension.item.executed",
            { itemId: item.id, status: "claimed" }, { itemId: item.id, status: "executed",
              targetUserId: target.userId, resultActionId: resultActionId.data, attempts });
        });
        executed += 1;
      } catch (error) {
        if (error instanceof Error && error.message === "INVALID_CLAIM") throw error;
        const manualReview = attempts >= 5;
        const lastErrorCode = manualReview ? "ADMIN_BULK_ITEM_MANUAL_REVIEW" : "ADMIN_BULK_ITEM_RETRY";
        await this.database.transaction(async (transaction) => {
          const tx = transaction as unknown as AdminDatabase;
          await this.loadClaim(tx, claim);
          const [updated] = await tx.update(adminBulkActionItems).set({
            status: manualReview ? "manual_review" : "retry", lastErrorCode, updatedAt: now,
          }).where(and(eq(adminBulkActionItems.id, item.id),
            eq(adminBulkActionItems.status, "claimed"))).returning();
          if (!updated) throw new Error("INVALID_CLAIM");
          await this.recordTransition(tx, request.row, now,
            `admin.bulk_suspension.item.${manualReview ? "manual_review" : "retry"}`,
            { itemId: item.id, status: "claimed" }, { itemId: item.id,
              status: manualReview ? "manual_review" : "retry", targetUserId: target.userId,
              attempts, lastErrorCode });
        });
        if (manualReview) hasManualReview = true; else hasRetry = true;
      }
    }
    if (hasManualReview) throw new Error("ADMIN_BULK_MANUAL_REVIEW");
    if (hasRetry) throw new Error("ADMIN_BULK_ITEMS_RETRY");
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const locked = await this.loadClaim(tx, claim);
      await this.finalize(tx, locked, now, { suspended: executed });
    });
  }

  private async release(claim: ClaimedAdminApproval, now: Date, code: string, forceManualReview: boolean) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const [request] = await tx.select().from(adminApprovalRequests).where(and(
        eq(adminApprovalRequests.id, claim.id), eq(adminApprovalRequests.status, "executing"),
        eq(adminApprovalRequests.leaseId, claim.leaseId),
        gt(adminApprovalRequests.leaseExpiresAt, sql`statement_timestamp()`),
      )).for("update").limit(1);
      if (!request) return "retry" as const;
      const attempts = request.attempts + 1;
      const manualReview = forceManualReview || attempts >= 5;
      if (request.action === "sensitive_export") {
        const [job] = await tx.select().from(adminExportJobs)
          .where(eq(adminExportJobs.approvalRequestId, request.id)).for("update").limit(1);
        if (job) await tx.update(adminExportJobs).set({ status: manualReview ? "manual_review" : "queued",
          attempts: job.attempts + 1,
          availableAt: new Date(now.getTime() + Math.min(60 * 60_000, 2 ** attempts * 1_000)),
          leaseId: null, leaseExpiresAt: null, lastErrorCode: code,
          manualReviewAt: manualReview ? now : null, updatedAt: now }).where(eq(adminExportJobs.id, job.id));
      }
      await tx.update(adminApprovalRequests).set({ status: manualReview ? "failed" : "approved", attempts,
        availableAt: new Date(now.getTime() + Math.min(60 * 60_000, 2 ** attempts * 1_000)),
        leaseId: null, leaseExpiresAt: null, lastErrorCode: code,
        manualReviewAt: manualReview ? now : null, updatedAt: now }).where(eq(adminApprovalRequests.id, request.id));
      await this.recordTransition(tx, request, now,
        `admin.${request.action}.${manualReview ? "manual_review" : "retry"}`,
        { status: "executing", attempts: request.attempts },
        { status: manualReview ? "failed" : "approved", attempts, lastErrorCode: code,
          manualReview });
      return manualReview ? "manual_review" as const : "retry" as const;
    });
  }
}
