import { randomUUID } from "node:crypto";

import { and, eq, gt, lte, or, sql } from "drizzle-orm";

import { adminApprovalDecisions, adminApprovalRequests, adminAuditLogs, adminExportJobs,
  adminOutboxEvents } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import type { AdminExportStorage } from "./admin-export-storage";
import { redactAuditDiff, sanitizeAuditReason } from "./audit-service";

type AdminDatabase = typeof productionDatabase;
type PurgeClaim = { id: string; leaseId: string; objectKey: string; storageVersionId: string };

export class DrizzleAdminExportPurgeRepository {
  constructor(private readonly database: AdminDatabase, private readonly storage: Pick<AdminExportStorage, "deleteVersion">) {}

  async claim(input: { limit: number; now: Date; leaseMs: number }): Promise<PurgeClaim[]> {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const jobs = await tx.select().from(adminExportJobs).where(or(
        and(eq(adminExportJobs.status, "ready"), lte(adminExportJobs.expiresAt, input.now),
          lte(adminExportJobs.availableAt, input.now)),
        and(eq(adminExportJobs.status, "purging"), lte(adminExportJobs.leaseExpiresAt, sql`statement_timestamp()`)),
      )).orderBy(adminExportJobs.expiresAt, adminExportJobs.id).for("update", { skipLocked: true }).limit(input.limit);
      const claims: PurgeClaim[] = [];
      for (const job of jobs) {
        if (!job.objectKey || !job.storageVersionId) continue;
        const leaseId = randomUUID();
        await tx.update(adminExportJobs).set({ status: "purging", leaseId,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), updatedAt: input.now })
          .where(eq(adminExportJobs.id, job.id));
        claims.push({ id: job.id, leaseId, objectKey: job.objectKey, storageVersionId: job.storageVersionId });
      }
      return claims;
    });
  }

  async purge(claim: PurgeClaim, now: Date): Promise<"purged" | "retry" | "manual_review"> {
    try {
      await this.storage.deleteVersion({ objectKey: claim.objectKey, versionId: claim.storageVersionId });
    } catch {
      return this.release(claim, now, "ADMIN_EXPORT_PURGE_RETRY");
    }
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const job = await this.loadClaim(tx, claim);
      const [request] = await tx.select().from(adminApprovalRequests)
        .where(eq(adminApprovalRequests.id, job.approvalRequestId)).limit(1);
      if (!request) throw new Error("ADMIN_EXPORT_PURGE_REQUEST_MISSING");
      const [updated] = await tx.update(adminExportJobs).set({ status: "purged", leaseId: null,
        leaseExpiresAt: null, lastErrorCode: null, updatedAt: now }).where(and(eq(adminExportJobs.id, claim.id),
          eq(adminExportJobs.status, "purging"), eq(adminExportJobs.leaseId, claim.leaseId),
          gt(adminExportJobs.leaseExpiresAt, sql`statement_timestamp()`))).returning();
      if (!updated) throw new Error("ADMIN_EXPORT_PURGE_LEASE_LOST");
      await this.record(tx, request, now, "admin.sensitive_export.purged", { exportStatus: "purging" },
        { exportStatus: "purged", artifactVersion: job.artifactVersion });
      return "purged" as const;
    });
  }

  private async loadClaim(tx: AdminDatabase, claim: PurgeClaim) {
    const [job] = await tx.select().from(adminExportJobs).where(and(eq(adminExportJobs.id, claim.id),
      eq(adminExportJobs.status, "purging"), eq(adminExportJobs.leaseId, claim.leaseId),
      gt(adminExportJobs.leaseExpiresAt, sql`statement_timestamp()`))).for("update").limit(1);
    if (!job) throw new Error("ADMIN_EXPORT_PURGE_LEASE_LOST");
    return job;
  }

  private async release(claim: PurgeClaim, now: Date, errorCode: string): Promise<"retry" | "manual_review"> {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const job = await this.loadClaim(tx, claim);
      const [request] = await tx.select().from(adminApprovalRequests)
        .where(eq(adminApprovalRequests.id, job.approvalRequestId)).limit(1);
      if (!request) throw new Error("ADMIN_EXPORT_PURGE_REQUEST_MISSING");
      const attempts = job.attempts + 1;
      const manualReview = attempts >= 5;
      await tx.update(adminExportJobs).set({ status: manualReview ? "manual_review" : "ready", attempts,
        availableAt: new Date(now.getTime() + Math.min(60 * 60_000, 2 ** attempts * 1_000)),
        leaseId: null, leaseExpiresAt: null, lastErrorCode: errorCode,
        manualReviewAt: manualReview ? now : null, updatedAt: now }).where(eq(adminExportJobs.id, job.id));
      await this.record(tx, request, now,
        `admin.sensitive_export.purge_${manualReview ? "manual_review" : "retry"}`,
        { exportStatus: "purging", attempts: job.attempts },
        { exportStatus: manualReview ? "manual_review" : "ready", attempts, lastErrorCode: errorCode });
      return manualReview ? "manual_review" as const : "retry" as const;
    });
  }

  private async record(tx: AdminDatabase, request: typeof adminApprovalRequests.$inferSelect, now: Date,
    eventType: string, before: unknown, after: unknown) {
    const [decision] = await tx.select({ actorUserId: adminApprovalDecisions.approverUserId })
      .from(adminApprovalDecisions).where(and(eq(adminApprovalDecisions.requestId, request.id),
        eq(adminApprovalDecisions.decision, "approved"))).limit(1);
    await tx.insert(adminOutboxEvents).values({ approvalRequestId: request.id, eventType,
      aggregateType: request.targetType, aggregateId: request.targetId,
      requestId: request.requestId, ipHash: request.ipHash,
      payload: { approvalRequestId: request.id, action: request.action, targetType: request.targetType,
        targetId: request.targetId, requestId: request.requestId, ipHash: request.ipHash,
        transition: redactAuditDiff(after) as Readonly<Record<string, unknown>> }, status: "pending", createdAt: now });
    await tx.insert(adminAuditLogs).values({ actorUserId: decision?.actorUserId ?? request.requesterUserId,
      permission: request.approvalPermission, targetType: request.targetType, targetId: request.targetId,
      beforeDiff: redactAuditDiff(before), afterDiff: redactAuditDiff(after), reason: sanitizeAuditReason(request.reason),
      requestId: request.requestId, ipHash: request.ipHash, createdAt: now });
  }
}

export class AdminExportPurgeWorker {
  private readonly now: () => Date;
  constructor(private readonly repository: DrizzleAdminExportPurgeRepository, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async run(rawLimit = 10) {
    const limit = Math.max(1, Math.min(25, Math.floor(rawLimit)));
    const claims = await this.repository.claim({ limit, now: this.now(), leaseMs: 30_000 });
    const result = { claimed: claims.length, purged: 0, retried: 0, manualReview: 0 };
    for (const claim of claims) {
      const outcome = await this.repository.purge(claim, this.now());
      if (outcome === "purged") result.purged += 1;
      else if (outcome === "retry") result.retried += 1;
      else result.manualReview += 1;
    }
    return result;
  }
}
