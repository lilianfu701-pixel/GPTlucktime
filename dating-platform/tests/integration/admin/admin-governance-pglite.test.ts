// @vitest-environment node

import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleAdminGovernanceProjection, DrizzleApprovalRepository,
  DrizzleVersionedEntitlementConfiguration } from "@/modules/admin/admin-repository";
import { createAdminEntitlementsHandler } from "@/modules/admin/admin-route";
import { AdminService } from "@/modules/admin/admin-service";
import { AdminApprovalWorker } from "@/modules/admin/admin-approval-worker";
import { DrizzleAdminApprovalExecutionRepository } from "@/modules/admin/admin-execution-repository";
import { AdminExportPurgeWorker, DrizzleAdminExportPurgeRepository } from "@/modules/admin/admin-export-purge";
import { AdminOutboxWorker, DrizzleAdminOutboxRepository } from "@/modules/admin/admin-outbox-dispatcher";
import { canonicalAdminJson, normalizeAndDeriveApproval } from "@/modules/admin/approval-contract";
import { DrizzleCaseService } from "@/modules/moderation/case-service";

let NOW = new Date();
let WORKER_NOW = new Date(NOW.getTime() + 5_000);
const PAYMENT_ID = "00000000-0000-4000-8000-000000000040";
const approvalHash = (input: { action: string; targetType: string; targetId: string;
  payloadVersion: number; payload: unknown }) => createHash("sha256").update(canonicalAdminJson({
  action: input.action, targetType: input.targetType, targetId: input.targetId,
  payloadVersion: input.payloadVersion, payload: input.payload,
})).digest("hex");

describe("0039 admin governance", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let requesterId: string;
  let approverId: string;
  let requesterSessionId: string;
  let approverSessionId: string;

  beforeEach(async () => {
    NOW = new Date();
    WORKER_NOW = new Date(NOW.getTime() + 5_000);
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    const users = await database.insert(schema.users).values([
      { name: "requester", email: "requester@admin.example", emailVerified: true },
      { name: "approver", email: "approver@admin.example", emailVerified: true },
    ]).returning();
    requesterId = users[0]!.id;
    approverId = users[1]!.id;
    const assignments = await database.insert(schema.adminRoleAssignments).values([
      { userId: requesterId, role: "finance", active: "active", createdAt: NOW },
      { userId: approverId, role: "finance", active: "active", createdAt: NOW },
    ]).returning();
    const sessions = await database.insert(schema.adminSessions).values([
      { userId: requesterId, roleAssignmentId: assignments[0]!.id, tokenHash: "1".repeat(64),
        mfaVerifiedAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, lastSeenAt: NOW },
      { userId: approverId, roleAssignmentId: assignments[1]!.id, tokenHash: "2".repeat(64),
        mfaVerifiedAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, lastSeenAt: NOW },
    ]).returning();
    requesterSessionId = sessions[0]!.id;
    approverSessionId = sessions[1]!.id;
  }, 30_000);

  afterEach(async () => client.close());

  const createApproval = async (expiresAt = new Date(NOW.getTime() + 60_000)) => {
    const bound = { action: "manual_refund" as const, targetType: "payment", targetId: PAYMENT_ID,
      payloadVersion: 1, payload: { paymentId: PAYMENT_ID, amount: 1000 } };
    const [request] = await database.insert(schema.adminApprovalRequests).values({
      requesterUserId: requesterId,
      requesterAdminSessionId: requesterSessionId,
      requestId: "00000000-0000-4000-8000-000000000099",
      ipHash: "c".repeat(64),
      action: bound.action,
      requestPermission: "billing.refund.request",
      approvalPermission: "billing.refund.approve",
      targetType: bound.targetType,
      targetId: bound.targetId,
      payloadVersion: bound.payloadVersion,
      payload: bound.payload,
      payloadHash: approvalHash(bound),
      reason: "verified duplicate charge",
      status: "pending",
      expiresAt,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
    return request!;
  };

  it("enforces independent, single-winner approval under concurrent decisions", async () => {
    const request = await createApproval();
    await expect(database.insert(schema.adminApprovalDecisions).values({
      requestId: request.id,
      approverUserId: requesterId,
      approverAdminSessionId: requesterSessionId,
      permission: "billing.refund.approve",
      decision: "approved",
      reason: "self approval",
      createdAt: NOW,
    })).rejects.toThrow();

    const results = await Promise.allSettled([0, 1].map(() => database.insert(schema.adminApprovalDecisions).values({
      requestId: request.id,
      approverUserId: approverId,
      approverAdminSessionId: approverSessionId,
      permission: "billing.refund.approve",
      decision: "approved",
      reason: "independent ledger review",
      createdAt: NOW,
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await database.select({ status: schema.adminApprovalRequests.status })
      .from(schema.adminApprovalRequests).where(eq(schema.adminApprovalRequests.id, request.id)))
      .toEqual([{ status: "approved" }]);
  });

  it("rejects direct DB requester and approver inserts without an active recent-MFA authorized admin session", async () => {
    const [ordinary] = await database.insert(schema.users).values({
      name: "ordinary", email: "ordinary@admin.example", emailVerified: true,
    }).returning();
    const [supportAssignment] = await database.insert(schema.adminRoleAssignments).values({
      userId: ordinary!.id, role: "support", active: "active", createdAt: NOW,
    }).returning();
    const [noMfaSession] = await database.insert(schema.adminSessions).values({
      userId: ordinary!.id, roleAssignmentId: supportAssignment!.id, tokenHash: "3".repeat(64),
      mfaVerifiedAt: null, expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, lastSeenAt: NOW,
    }).returning();
    await expect(database.insert(schema.adminApprovalRequests).values({
      requesterUserId: ordinary!.id, requesterAdminSessionId: noMfaSession!.id,
      requestId: "00000000-0000-4000-8000-000000000088", ipHash: "d".repeat(64),
      action: "manual_refund", requestPermission: "billing.refund.request",
      approvalPermission: "billing.refund.approve", targetType: "payment", targetId: "payment-2",
      payloadVersion: 1, payload: {}, payloadHash: "e".repeat(64), reason: "direct insert",
      expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    })).rejects.toThrow();

    const request = await createApproval();
    await expect(database.insert(schema.adminApprovalDecisions).values({
      requestId: request.id, approverUserId: ordinary!.id, approverAdminSessionId: noMfaSession!.id,
      permission: "billing.refund.approve", decision: "approved", reason: "direct insert", createdAt: NOW,
    })).rejects.toThrow();
  });

  it("rejects a direct outbox delivery that bypasses a live worker lease", async () => {
    const request = await createApproval();
    const [event] = await database.insert(schema.adminOutboxEvents).values({ approvalRequestId: request.id,
      eventType: "admin.manual_refund.requested", aggregateType: request.targetType, aggregateId: request.targetId,
      requestId: request.requestId, ipHash: request.ipHash,
      payload: { approvalRequestId: request.id, targetType: request.targetType, targetId: request.targetId,
        requestId: request.requestId, ipHash: request.ipHash }, status: "pending",
      createdAt: NOW }).returning();
    await expect(database.update(schema.adminOutboxEvents).set({ status: "delivered" })
      .where(eq(schema.adminOutboxEvents.id, event!.id))).rejects.toThrow();
  });

  it("leases, retries and delivers an admin outbox event once through a stable event id", async () => {
    const request = await createApproval();
    const [event] = await database.insert(schema.adminOutboxEvents).values({ approvalRequestId: request.id,
      eventType: "admin.manual_refund.requested", aggregateType: request.targetType, aggregateId: request.targetId,
      requestId: request.requestId, ipHash: request.ipHash,
      payload: { approvalRequestId: request.id, targetType: request.targetType, targetId: request.targetId,
        requestId: request.requestId, ipHash: request.ipHash }, status: "pending", createdAt: NOW }).returning();
    const publish = vi.fn().mockRejectedValueOnce(new Error("sink offline: private payload"))
      .mockResolvedValue(undefined);
    const repository = new DrizzleAdminOutboxRepository(database as never, { publish });
    const first = await new AdminOutboxWorker(repository, { now: () => WORKER_NOW }).run(10);
    expect(first).toEqual({ claimed: 1, delivered: 0, retried: 1, manualReview: 0 });
    const [retrying] = await database.select().from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.id, event!.id));
    expect(retrying).toEqual(expect.objectContaining({ status: "retrying", attempts: 1,
      lastErrorCode: "ADMIN_OUTBOX_DELIVERY_RETRY" }));
    const retryNow = new Date(retrying!.availableAt.getTime() + 1_000);
    const second = await new AdminOutboxWorker(repository, { now: () => retryNow }).run(10);
    expect(second).toEqual({ claimed: 1, delivered: 1, retried: 0, manualReview: 0 });
    expect(publish).toHaveBeenNthCalledWith(1, expect.objectContaining({ eventId: event!.id,
      deduplicationKey: event!.id }));
    expect(publish).toHaveBeenNthCalledWith(2, expect.objectContaining({ eventId: event!.id,
      deduplicationKey: event!.id }));
    await new AdminOutboxWorker(repository, { now: () => new Date(retryNow.getTime() + 1_000) }).run(10);
    expect(publish).toHaveBeenCalledTimes(2);
    expect((await database.select({ status: schema.adminOutboxEvents.status }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.id, event!.id)))[0]!.status).toBe("delivered");
    const [recoveryEvent] = await database.insert(schema.adminOutboxEvents).values({ approvalRequestId: request.id,
      eventType: "admin.manual_refund.recovery_fixture", aggregateType: request.targetType,
      aggregateId: request.targetId, requestId: request.requestId, ipHash: request.ipHash,
      payload: { approvalRequestId: request.id, targetType: request.targetType, targetId: request.targetId,
        requestId: request.requestId, ipHash: request.ipHash }, status: "pending", createdAt: NOW }).returning();
    const recoveryClaim = await repository.claim({ limit: 1, now: new Date(), leaseMs: 100 });
    expect(recoveryClaim[0]?.eventId).toBe(recoveryEvent!.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(new AdminOutboxWorker(repository, { now: () => new Date() }).run(10))
      .resolves.toEqual({ claimed: 1, delivered: 1, retried: 0, manualReview: 0 });
    expect((await database.select({ status: schema.adminOutboxEvents.status }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.id, recoveryEvent!.id)))[0]!.status).toBe("delivered");

    const [terminalEvent] = await database.insert(schema.adminOutboxEvents).values({ approvalRequestId: request.id,
      eventType: "admin.manual_refund.failure_fixture", aggregateType: request.targetType,
      aggregateId: request.targetId, requestId: request.requestId, ipHash: request.ipHash,
      payload: { approvalRequestId: request.id, targetType: request.targetType, targetId: request.targetId,
        requestId: request.requestId, ipHash: request.ipHash }, status: "pending", createdAt: NOW }).returning();
    const failingRepository = new DrizzleAdminOutboxRepository(database as never,
      { publish: vi.fn(async () => { throw new Error("sink unavailable"); }) });
    let failureNow = new Date();
    let terminal = { claimed: 0, delivered: 0, retried: 0, manualReview: 0 };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      terminal = await new AdminOutboxWorker(failingRepository, { now: () => failureNow }).run(10);
      const [row] = await database.select().from(schema.adminOutboxEvents)
        .where(eq(schema.adminOutboxEvents.id, terminalEvent!.id));
      failureNow = new Date(row!.availableAt.getTime() + 1_000);
    }
    expect(terminal.manualReview).toBe(1);
    expect((await database.select({ status: schema.adminOutboxEvents.status,
      manualReviewAt: schema.adminOutboxEvents.manualReviewAt }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.id, terminalEvent!.id)))[0])
      .toEqual({ status: "failed", manualReviewAt: expect.any(Date) });
  });

  it("moves repeatedly crashed outbox leases to manual failure before the attempts check can deadlock", async () => {
    const request = await createApproval();
    const [event] = await database.insert(schema.adminOutboxEvents).values({ approvalRequestId: request.id,
      eventType: "admin.manual_refund.crash_fixture", aggregateType: request.targetType,
      aggregateId: request.targetId, requestId: request.requestId, ipHash: request.ipHash,
      payload: { approvalRequestId: request.id, targetType: request.targetType, targetId: request.targetId,
        requestId: request.requestId, ipHash: request.ipHash }, status: "pending", createdAt: NOW }).returning();
    const repository = new DrizzleAdminOutboxRepository(database as never, { publish: vi.fn() });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const claims = await repository.claim({ limit: 1, now: new Date(), leaseMs: 50 });
      expect(claims).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await expect(repository.claim({ limit: 1, now: new Date(), leaseMs: 50 })).resolves.toEqual([]);
    expect((await database.select({ status: schema.adminOutboxEvents.status,
      attempts: schema.adminOutboxEvents.attempts, manualReviewAt: schema.adminOutboxEvents.manualReviewAt })
      .from(schema.adminOutboxEvents).where(eq(schema.adminOutboxEvents.id, event!.id)))[0])
      .toEqual({ status: "failed", attempts: 5, manualReviewAt: expect.any(Date) });
  });

  it("rejects direct DB approval payloads whose action-derived target does not match", async () => {
    const base = {
      requesterUserId: requesterId, requesterAdminSessionId: requesterSessionId,
      requestId: "00000000-0000-4000-8000-000000000097", ipHash: "d".repeat(64),
      requestPermission: "billing.refund.request", approvalPermission: "billing.refund.approve",
      payloadVersion: 1, payloadHash: "e".repeat(64), reason: "verified duplicate charge",
      status: "pending" as const, expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    };
    await expect(database.insert(schema.adminApprovalRequests).values({ ...base,
      action: "manual_refund", targetType: "user", targetId: approverId,
      payload: { paymentId: PAYMENT_ID, amount: 1000 },
    })).rejects.toThrow();
    await expect(database.insert(schema.adminApprovalRequests).values({ ...base,
      action: "manual_refund", targetType: "payment", targetId: PAYMENT_ID,
      payload: { paymentId: null, amount: 1000 },
    })).rejects.toThrow();
    await expect(database.insert(schema.adminApprovalRequests).values({ ...base,
      action: "manual_refund", targetType: "payment", targetId: PAYMENT_ID,
      payload: { paymentId: PAYMENT_ID, amount: 1000 }, payloadHash: "0".repeat(64),
    })).rejects.toThrow();
    const validRefundBound = { action: "manual_refund", targetType: "payment", targetId: PAYMENT_ID,
      payloadVersion: 1, payload: { paymentId: PAYMENT_ID, amount: 1000 } };
    for (const forbiddenInitial of [
      { status: "approved" as const }, { status: "rejected" as const },
      { status: "executing" as const, leaseId: "00000000-0000-4000-8000-000000000069",
        leaseExpiresAt: new Date(NOW.getTime() + 30_000) },
    ]) {
      await expect(database.insert(schema.adminApprovalRequests).values({ ...base,
        action: "manual_refund", targetType: "payment", targetId: PAYMENT_ID,
        payload: validRefundBound.payload, payloadHash: approvalHash(validRefundBound), ...forbiddenInitial,
      })).rejects.toThrow();
    }
    const [pendingBypass] = await database.insert(schema.adminApprovalRequests).values({ ...base,
      action: "manual_refund", targetType: "payment", targetId: PAYMENT_ID,
      payload: validRefundBound.payload, payloadHash: approvalHash(validRefundBound), status: "pending",
    }).returning();
    await expect(database.update(schema.adminApprovalRequests).set({ status: "approved" })
      .where(eq(schema.adminApprovalRequests.id, pendingBypass!.id))).rejects.toThrow();
    await expect(database.insert(schema.adminApprovalRequests).values({ ...base,
      action: "manual_refund", targetType: "payment", targetId: PAYMENT_ID,
      payload: validRefundBound.payload, payloadHash: approvalHash(validRefundBound),
      reason: "call +1 (206) 555-0100 for review", status: "pending",
    })).rejects.toThrow();
    const nullInterval = { planId: requesterId, expectedVersion: 0, countryCode: "US", currency: "USD",
      unitAmount: 1000, interval: null, intervalCount: 1, taxMode: "exclusive",
      providerPriceId: "price_safe_ref", effectiveAt: NOW.toISOString() };
    const nullIntervalBound = { action: "payment_configuration", targetType: "billing_price",
      targetId: `${requesterId}:US:USD`, payloadVersion: 1, payload: nullInterval };
    await expect(database.insert(schema.adminApprovalRequests).values({ ...base,
      action: "payment_configuration", requestPermission: "billing.config.write",
      approvalPermission: "billing.config.approve", targetType: nullIntervalBound.targetType,
      targetId: nullIntervalBound.targetId, payload: nullInterval, payloadHash: approvalHash(nullIntervalBound),
    })).rejects.toThrow();
    await expect(database.insert(schema.adminApprovalRequests).values({ ...base,
      action: "sensitive_export", requestPermission: "exports.sensitive.request",
      approvalPermission: "exports.sensitive.approve", targetType: "export_scope", targetId: PAYMENT_ID,
      payload: { exportKind: "billing_ledger", scope: { subjectUserId: requesterId } },
    })).rejects.toThrow();
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    const nullExport = { exportKind: null, scope: { subjectUserId: requesterId } };
    const nullExportBound = { action: "sensitive_export", targetType: "export_scope",
      targetId: createHash("sha256").update(canonicalAdminJson(nullExport)).digest("hex"),
      payloadVersion: 1, payload: nullExport };
    await expect(database.insert(schema.adminApprovalRequests).values({ ...base,
      action: "sensitive_export", requestPermission: "exports.sensitive.request",
      approvalPermission: "exports.sensitive.approve", targetType: nullExportBound.targetType,
      targetId: nullExportBound.targetId, payload: nullExport, payloadHash: approvalHash(nullExportBound),
    })).rejects.toThrow();
    await database.update(schema.adminRoleAssignments).set({ role: "safety" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    const mismatchedBulk = normalizeAndDeriveApproval({ action: "bulk_suspension", payloadVersion: 1,
      payload: { reasonCode: "coordinated abuse", targets: [{
        userId: "00000000-0000-4000-8000-000000000020",
        caseId: "00000000-0000-4000-8000-000000000021", expectedVersion: 7, durationHours: 24,
      }] }, reason: "coordinated abuse" });
    await expect(database.insert(schema.adminApprovalRequests).values({ ...base, action: mismatchedBulk.action,
      requestPermission: "users.bulk_suspend.request", approvalPermission: "users.bulk_suspend.approve",
      targetType: mismatchedBulk.targetType, targetId: mismatchedBulk.targetId, payload: mismatchedBulk.payload,
    })).rejects.toThrow();
  });

  it("rejects a forged safety grant that binds both evidence and message targets", async () => {
    await database.update(schema.adminRoleAssignments).set({ role: "safety" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    await database.update(schema.adminRoleAssignments).set({ role: "safety" })
      .where(eq(schema.adminRoleAssignments.userId, approverId));
    const [target] = await database.insert(schema.users).values({ name: "safety-target",
      email: "safety-target@example.test", emailVerified: true }).returning();
    const [profile] = await database.insert(schema.profiles).values({ userId: target!.id,
      displayName: "Safety target", birthDate: "1990-01-01", genderCode: "person",
      relationshipGoalCode: "long_term", countryCode: "US", city: "Seattle", timeZone: "UTC",
      status: "active", discoverable: true }).returning();
    const [lowUserId, highUserId] = [requesterId, target!.id].sort();
    const [conversation] = await database.insert(schema.conversations).values({ lowUserId, highUserId }).returning();
    await database.insert(schema.conversationMembers).values([
      { conversationId: conversation!.id, userId: lowUserId, lowUserId, highUserId },
      { conversationId: conversation!.id, userId: highUserId, lowUserId, highUserId },
    ]);
    const [message] = await database.insert(schema.messages).values({ conversationId: conversation!.id,
      lowUserId, highUserId, sequence: 1, senderUserId: target!.id,
      clientId: "00000000-0000-4000-8000-000000000090", body: "private evidence" }).returning();
    const [report] = await database.insert(schema.reports).values({ reporterUserId: requesterId,
      targetUserId: target!.id, targetProfileId: profile!.id, targetType: "message", messageId: message!.id,
      conversationId: conversation!.id, reasonCode: "THREATS_OR_VIOLENCE", locale: "en-US",
      explanation: "bounded safety fixture", clientId: "00000000-0000-4000-8000-000000000091",
      requestHash: "9".repeat(64), dedupeKey: "8".repeat(64), targetSnapshot: { schemaVersion: 1,
        targetType: "message", targetUserId: target!.id, targetProfileId: profile!.id,
        capturedAt: NOW.toISOString(), displayName: null, messageId: message!.id,
        conversationId: conversation!.id } }).returning();
    const [moderationCase] = await database.insert(schema.moderationCases)
      .values({ reportId: report!.id }).returning();
    const [evidence] = await database.insert(schema.moderationEvidence).values({ reportId: report!.id,
      caseId: moderationCase!.id, kind: "message_reference", classification: "ordinary",
      locator: { schemaVersion: 1, referenceType: "message", referenceId: message!.id },
      integritySha256: "7".repeat(64), preserveUntil: new Date(NOW.getTime() + 60_000) }).returning();
    const input = normalizeAndDeriveApproval({ action: "safety_evidence_access", payloadVersion: 1,
      payload: { actorUserId: requesterId, caseId: moderationCase!.id, reportId: report!.id,
        evidenceId: evidence!.id, expiresAt: new Date(NOW.getTime() + 30_000).toISOString() },
      reason: "independent evidence access review" });
    const [request] = await database.insert(schema.adminApprovalRequests).values({ requesterUserId: requesterId,
      requesterAdminSessionId: requesterSessionId, requestId: "00000000-0000-4000-8000-000000000092",
      ipHash: "7".repeat(64), action: input.action, requestPermission: "safety.evidence.request",
      approvalPermission: "safety.evidence.approve", targetType: input.targetType, targetId: input.targetId,
      payloadVersion: 1, payload: input.payload, payloadHash: approvalHash(input), reason: input.reason,
      status: "pending", expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW }).returning();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request!.id, approverUserId: approverId,
      approverAdminSessionId: approverSessionId, permission: "safety.evidence.approve", decision: "approved",
      reason: "independent target verification", createdAt: NOW });
    const repository = new DrizzleAdminApprovalExecutionRepository(database as never, { applyUserAction: vi.fn() },
      { createRefund: vi.fn() }, {} as never);
    const [claim] = await repository.claim({ limit: 1, now: WORKER_NOW, leaseMs: 30_000 });
    await expect(database.insert(schema.adminSafetyAccessGrants).values({ approvalRequestId: request!.id,
      actorUserId: requesterId, caseId: moderationCase!.id, reportId: report!.id,
      evidenceId: evidence!.id, messageId: message!.id, expiresAt: new Date(NOW.getTime() + 30_000),
      createdAt: NOW })).rejects.toThrow();
    expect(claim?.id).toBe(request!.id);
  });

  it("executes a sensitive export only after it is durable and purges the exact expired version", async () => {
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, approverId));
    const input = normalizeAndDeriveApproval({ action: "sensitive_export", payloadVersion: 1,
      payload: { exportKind: "billing_ledger", scope: { subjectUserId: requesterId } },
      reason: "independent bounded export review" });
    const [request] = await database.insert(schema.adminApprovalRequests).values({
      requesterUserId: requesterId, requesterAdminSessionId: requesterSessionId,
      requestId: "00000000-0000-4000-8000-000000000096", ipHash: "f".repeat(64),
      action: input.action, requestPermission: "exports.sensitive.request",
      approvalPermission: "exports.sensitive.approve", targetType: input.targetType, targetId: input.targetId,
      payloadVersion: input.payloadVersion, payload: input.payload, payloadHash: approvalHash(input), reason: input.reason,
      status: "pending", expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    const exportSpec = input.payload as { exportKind: string; scope: Readonly<Record<string, unknown>> };
    await expect(database.insert(schema.adminExportJobs).values({ approvalRequestId: request!.id,
      requestedByUserId: requesterId, exportKind: exportSpec.exportKind, scope: exportSpec.scope,
      payloadHash: request!.payloadHash, status: "queued", createdAt: NOW, updatedAt: NOW,
    })).rejects.toThrow();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request!.id,
      approverUserId: approverId, approverAdminSessionId: approverSessionId,
      permission: "exports.sensitive.approve", decision: "approved", reason: "scope independently verified", createdAt: NOW });
    await expect(database.insert(schema.adminExportJobs).values({ approvalRequestId: request!.id,
      requestedByUserId: requesterId, exportKind: exportSpec.exportKind, scope: exportSpec.scope,
      payloadHash: request!.payloadHash, status: "ready", objectKey: "admin-exports/forged.json",
      artifactVersion: 1, storageVersionId: "forged", contentHash: "0".repeat(64), sizeBytes: 1,
      expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    })).rejects.toThrow();
    await expect(database.insert(schema.adminExportJobs).values({ approvalRequestId: request!.id,
      requestedByUserId: requesterId, exportKind: exportSpec.exportKind, scope: exportSpec.scope,
      payloadHash: request!.payloadHash, status: "processing", createdAt: NOW, updatedAt: NOW,
    })).rejects.toThrow();
    const storage = { putEncrypted: vi.fn(async (artifact: { body: Uint8Array }) => ({ versionId: "version-1",
      sizeBytes: artifact.body.byteLength })) };
    const repository = new DrizzleAdminApprovalExecutionRepository(database as never,
      { applyUserAction: vi.fn() }, { createRefund: vi.fn() }, storage as never);
    const result = await new AdminApprovalWorker(repository, { now: () => WORKER_NOW }).run(10);
    expect(result.executed).toBe(1);
    expect(storage.putEncrypted).toHaveBeenCalledTimes(1);
    const [job] = await database.select().from(schema.adminExportJobs)
      .where(eq(schema.adminExportJobs.approvalRequestId, request!.id));
    expect(job).toEqual(expect.objectContaining({ status: "ready", objectKey: expect.stringMatching(/^admin-exports\//u),
      artifactVersion: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u), sizeBytes: expect.any(Number),
      expiresAt: expect.any(Date) }));
    const directPurgeLease = "00000000-0000-4000-8000-000000000065";
    await database.update(schema.adminExportJobs).set({ status: "purging", leaseId: directPurgeLease,
      leaseExpiresAt: new Date(Date.now() + 30_000), updatedAt: new Date() })
      .where(eq(schema.adminExportJobs.id, job!.id));
    await expect(database.update(schema.adminExportJobs).set({ status: "ready", leaseId: null,
      leaseExpiresAt: null, objectKey: "admin-exports/another-request/another-object.json",
      storageVersionId: "another-version", updatedAt: new Date() })
      .where(eq(schema.adminExportJobs.id, job!.id))).rejects.toThrow();
    await database.update(schema.adminExportJobs).set({ status: "ready", leaseId: null,
      leaseExpiresAt: null, updatedAt: new Date() }).where(eq(schema.adminExportJobs.id, job!.id));
    expect(JSON.parse(new TextDecoder().decode(storage.putEncrypted.mock.calls[0]![0].body)))
      .toEqual(expect.objectContaining({ schema: "admin-sensitive-export", version: 1, kind: "billing_ledger" }));
    expect((await database.select({ status: schema.adminApprovalRequests.status }).from(schema.adminApprovalRequests)
      .where(eq(schema.adminApprovalRequests.id, request!.id)))[0]!.status).toBe("executed");
    const successEvents = await database.select({ eventType: schema.adminOutboxEvents.eventType })
      .from(schema.adminOutboxEvents).where(eq(schema.adminOutboxEvents.approvalRequestId, request!.id));
    expect(successEvents.map((row) => row.eventType)).toEqual(expect.arrayContaining([
      "admin.sensitive_export.processing", "admin.sensitive_export.ready", "admin.sensitive_export.executed",
    ]));
    expect(await database.select().from(schema.adminAuditLogs)
      .where(eq(schema.adminAuditLogs.targetId, input.targetId))).toHaveLength(4);
    const deleteVersion = vi.fn(async () => undefined);
    const purgeNow = new Date(job!.expiresAt!.getTime() + 1_000);
    const purge = await new AdminExportPurgeWorker(new DrizzleAdminExportPurgeRepository(
      database as never, { deleteVersion } as never), { now: () => purgeNow }).run(10);
    expect(purge).toEqual({ claimed: 1, purged: 1, retried: 0, manualReview: 0 });
    expect(deleteVersion).toHaveBeenCalledWith({ objectKey: job!.objectKey,
      versionId: job!.storageVersionId });
    expect((await database.select({ status: schema.adminExportJobs.status }).from(schema.adminExportJobs)
      .where(eq(schema.adminExportJobs.id, job!.id)))[0]!.status).toBe("purged");
    expect((await database.select({ eventType: schema.adminOutboxEvents.eventType })
      .from(schema.adminOutboxEvents).where(eq(schema.adminOutboxEvents.approvalRequestId, request!.id)))
      .map((row) => row.eventType)).toContain("admin.sensitive_export.purged");

    const [failureRequest] = await database.insert(schema.adminApprovalRequests).values({
      requesterUserId: requesterId, requesterAdminSessionId: requesterSessionId,
      requestId: "00000000-0000-4000-8000-000000000066", ipHash: "6".repeat(64),
      action: input.action, requestPermission: "exports.sensitive.request",
      approvalPermission: "exports.sensitive.approve", targetType: input.targetType, targetId: input.targetId,
      payloadVersion: input.payloadVersion, payload: input.payload, payloadHash: approvalHash(input), reason: input.reason,
      status: "pending", expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: failureRequest!.id,
      approverUserId: approverId, approverAdminSessionId: approverSessionId,
      permission: "exports.sensitive.approve", decision: "approved", reason: "second independent scope review",
      createdAt: NOW });
    const failureStorage = { putEncrypted: vi.fn(async (artifact: { body: Uint8Array }) => ({
      versionId: "version-failure-fixture", sizeBytes: artifact.body.byteLength })) };
    await new AdminApprovalWorker(new DrizzleAdminApprovalExecutionRepository(database as never,
      { applyUserAction: vi.fn() }, { createRefund: vi.fn() }, failureStorage as never),
    { now: () => WORKER_NOW }).run(10);
    const [failureJob] = await database.select().from(schema.adminExportJobs)
      .where(eq(schema.adminExportJobs.approvalRequestId, failureRequest!.id));
    const failedDelete = vi.fn(async () => { throw new Error("storage unavailable: sensitive details"); });
    const failedPurgeRepository = new DrizzleAdminExportPurgeRepository(database as never,
      { deleteVersion: failedDelete } as never);
    let purgeFailureNow = new Date(failureJob!.expiresAt!.getTime() + 1_000);
    let purgeManualReviews = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const purgeFailure = await new AdminExportPurgeWorker(failedPurgeRepository,
        { now: () => purgeFailureNow }).run(10);
      purgeManualReviews += purgeFailure.manualReview;
      const [row] = await database.select().from(schema.adminExportJobs)
        .where(eq(schema.adminExportJobs.id, failureJob!.id));
      purgeFailureNow = new Date(row!.availableAt.getTime() + 1_000);
    }
    expect(purgeManualReviews).toBe(1);
    expect((await database.select({ status: schema.adminExportJobs.status,
      lastErrorCode: schema.adminExportJobs.lastErrorCode }).from(schema.adminExportJobs)
      .where(eq(schema.adminExportJobs.id, failureJob!.id)))[0])
      .toEqual({ status: "manual_review", lastErrorCode: "ADMIN_EXPORT_PURGE_RETRY" });
    expect((await database.select({ eventType: schema.adminOutboxEvents.eventType })
      .from(schema.adminOutboxEvents).where(eq(schema.adminOutboxEvents.approvalRequestId, failureRequest!.id)))
      .map((row) => row.eventType)).toContain("admin.sensitive_export.purge_manual_review");
  });

  it("keeps a sensitive export retryable and unexecuted when durable storage fails", async () => {
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, approverId));
    const input = normalizeAndDeriveApproval({ action: "sensitive_export", payloadVersion: 1,
      payload: { exportKind: "billing_ledger", scope: { subjectUserId: requesterId } },
      reason: "independent bounded export review" });
    const [request] = await database.insert(schema.adminApprovalRequests).values({
      requesterUserId: requesterId, requesterAdminSessionId: requesterSessionId,
      requestId: "00000000-0000-4000-8000-000000000095", ipHash: "f".repeat(64),
      action: input.action, requestPermission: "exports.sensitive.request",
      approvalPermission: "exports.sensitive.approve", targetType: input.targetType, targetId: input.targetId,
      payloadVersion: input.payloadVersion, payload: input.payload, payloadHash: approvalHash(input), reason: input.reason,
      status: "pending", expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request!.id,
      approverUserId: approverId, approverAdminSessionId: approverSessionId,
      permission: "exports.sensitive.approve", decision: "approved", reason: "scope independently verified", createdAt: NOW });
    const storage = { putEncrypted: vi.fn(async () => { throw new Error("storage offline: private details"); }) };
    const repository = new DrizzleAdminApprovalExecutionRepository(database as never,
      { applyUserAction: vi.fn() }, { createRefund: vi.fn() }, storage as never);
    const result = await new AdminApprovalWorker(repository, { now: () => WORKER_NOW }).run(10);
    expect(result.retried).toBe(1);
    const [job] = await database.select().from(schema.adminExportJobs)
      .where(eq(schema.adminExportJobs.approvalRequestId, request!.id));
    expect(job).toEqual(expect.objectContaining({ status: "queued", attempts: 1,
      lastErrorCode: "ADMIN_EXPORT_STORAGE_RETRY" }));
    expect((await database.select({ status: schema.adminApprovalRequests.status }).from(schema.adminApprovalRequests)
      .where(eq(schema.adminApprovalRequests.id, request!.id)))[0]!.status).toBe("approved");
    expect(await database.select({ eventType: schema.adminOutboxEvents.eventType }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.approvalRequestId, request!.id)))
      .toEqual(expect.arrayContaining([{ eventType: "admin.sensitive_export.processing" },
        { eventType: "admin.sensitive_export.retry" }]));
    const retryAudit = (await database.select().from(schema.adminAuditLogs)
      .where(eq(schema.adminAuditLogs.targetId, input.targetId)))
      .find((row) => (row.afterDiff as Record<string, unknown>).lastErrorCode === "ADMIN_EXPORT_STORAGE_RETRY");
    expect(retryAudit).toEqual(expect.objectContaining({ requestId: "00000000-0000-4000-8000-000000000095",
      ipHash: "f".repeat(64), afterDiff: expect.objectContaining({ status: "approved",
        lastErrorCode: "ADMIN_EXPORT_STORAGE_RETRY" }) }));
    await database.update(schema.adminApprovalRequests).set({ attempts: 4, availableAt: WORKER_NOW })
      .where(eq(schema.adminApprovalRequests.id, request!.id));
    const terminal = await new AdminApprovalWorker(repository,
      { now: () => new Date(WORKER_NOW.getTime() + 10_000) }).run(10);
    expect(terminal.manualReview).toBe(1);
    expect((await database.select({ status: schema.adminApprovalRequests.status }).from(schema.adminApprovalRequests)
      .where(eq(schema.adminApprovalRequests.id, request!.id)))[0]!.status).toBe("failed");
    expect((await database.select({ status: schema.adminExportJobs.status }).from(schema.adminExportJobs)
      .where(eq(schema.adminExportJobs.approvalRequestId, request!.id)))[0]!.status).toBe("manual_review");
    expect((await database.select({ eventType: schema.adminOutboxEvents.eventType }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.approvalRequestId, request!.id))).map((row) => row.eventType))
      .toContain("admin.sensitive_export.manual_review");
  });

  it("moves a ready export to manual review when HEAD-only integrity verification fails", async () => {
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, approverId));
    const input = normalizeAndDeriveApproval({ action: "sensitive_export", payloadVersion: 1,
      payload: { exportKind: "billing_ledger", scope: { subjectUserId: requesterId } },
      reason: "independent bounded export review" });
    const [request] = await database.insert(schema.adminApprovalRequests).values({ requesterUserId: requesterId,
      requesterAdminSessionId: requesterSessionId, requestId: "00000000-0000-4000-8000-000000000068",
      ipHash: "6".repeat(64), action: input.action, requestPermission: "exports.sensitive.request",
      approvalPermission: "exports.sensitive.approve", targetType: input.targetType, targetId: input.targetId,
      payloadVersion: 1, payload: input.payload, payloadHash: approvalHash(input), reason: input.reason,
      status: "pending", expiresAt: new Date(WORKER_NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request!.id, approverUserId: approverId,
      approverAdminSessionId: approverSessionId, permission: "exports.sensitive.approve", decision: "approved",
      reason: "independent scope review", createdAt: NOW });
    const storage = { putEncrypted: vi.fn(), verifyEncrypted: vi.fn(async () => { throw new Error("not found"); }),
      deleteVersion: vi.fn() };
    const repository = new DrizzleAdminApprovalExecutionRepository(database as never, { applyUserAction: vi.fn() },
      { createRefund: vi.fn() }, storage);
    const [claim] = await repository.claim({ limit: 1, now: WORKER_NOW, leaseMs: 30_000 });
    const exportScope = (input.payload as { scope: { subjectUserId: string } }).scope;
    const artifact = new TextEncoder().encode(canonicalAdminJson({ schema: "admin-sensitive-export", version: 1,
      kind: "billing_ledger", generatedAt: request!.createdAt.toISOString(), scope: exportScope, records: [] }));
    const contentHash = createHash("sha256").update(artifact).digest("hex");
    const [job] = await database.insert(schema.adminExportJobs).values({ approvalRequestId: request!.id,
      requestedByUserId: requesterId, exportKind: "billing_ledger", scope: exportScope,
      payloadHash: request!.payloadHash, status: "queued", createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.update(schema.adminExportJobs).set({ status: "processing", leaseId: claim!.leaseId,
      leaseExpiresAt: new Date(WORKER_NOW.getTime() + 30_000), updatedAt: WORKER_NOW })
      .where(eq(schema.adminExportJobs.id, job!.id));
    const objectKey = `admin-exports/${request!.id}/${request!.payloadHash}.v1.json`;
    const artifactExpiresAt = new Date(WORKER_NOW.getTime() + 24 * 60 * 60_000);
    await database.update(schema.adminExportJobs).set({ status: "ready", objectKey, artifactVersion: 1,
      storageVersionId: "missing-version", contentHash, sizeBytes: artifact.byteLength,
      expiresAt: artifactExpiresAt, leaseId: null, leaseExpiresAt: null, updatedAt: WORKER_NOW })
      .where(eq(schema.adminExportJobs.id, job!.id));
    await expect(repository.execute(claim!, WORKER_NOW)).resolves.toBe("manual_review");
    expect(storage.verifyEncrypted).toHaveBeenCalledTimes(1);
    expect(storage.putEncrypted).not.toHaveBeenCalled();
    expect((await database.select({ status: schema.adminExportJobs.status,
      objectKey: schema.adminExportJobs.objectKey }).from(schema.adminExportJobs)
      .where(eq(schema.adminExportJobs.id, job!.id)))[0]).toEqual({ status: "manual_review", objectKey });
    expect((await database.select({ status: schema.adminApprovalRequests.status }).from(schema.adminApprovalRequests)
      .where(eq(schema.adminApprovalRequests.id, request!.id)))[0]!.status).toBe("failed");
  });

  it("recovers an expired executing lease after the approval request expiry", async () => {
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    await database.update(schema.adminRoleAssignments).set({ role: "super_admin" })
      .where(eq(schema.adminRoleAssignments.userId, approverId));
    const input = normalizeAndDeriveApproval({ action: "sensitive_export", payloadVersion: 1,
      payload: { exportKind: "billing_ledger", scope: { subjectUserId: requesterId } },
      reason: "bounded crash recovery review" });
    const [request] = await database.insert(schema.adminApprovalRequests).values({
      requesterUserId: requesterId, requesterAdminSessionId: requesterSessionId,
      requestId: "00000000-0000-4000-8000-000000000094", ipHash: "f".repeat(64),
      action: input.action, requestPermission: "exports.sensitive.request", approvalPermission: "exports.sensitive.approve",
      targetType: input.targetType, targetId: input.targetId, payloadVersion: 1, payload: input.payload,
      payloadHash: approvalHash(input), reason: input.reason, status: "pending",
      expiresAt: new Date(WORKER_NOW.getTime() + 1_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request!.id, approverUserId: approverId,
      approverAdminSessionId: approverSessionId, permission: "exports.sensitive.approve", decision: "approved",
      reason: "independent crash recovery review", createdAt: NOW });
    const repository = new DrizzleAdminApprovalExecutionRepository(database as never, { applyUserAction: vi.fn() },
      { createRefund: vi.fn() }, { putEncrypted: vi.fn() } as never);
    const first = await repository.claim({ limit: 1, now: WORKER_NOW, leaseMs: 500 });
    expect(first).toHaveLength(1);
    await database.update(schema.adminApprovalRequests).set({ leaseExpiresAt: new Date(NOW.getTime() - 1_000) })
      .where(eq(schema.adminApprovalRequests.id, request!.id));
    const recovered = await repository.claim({ limit: 1, now: new Date(WORKER_NOW.getTime() + 2_000), leaseMs: 500 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe(first[0]!.id);
    expect(recovered[0]!.leaseId).not.toBe(first[0]!.leaseId);
    const [pending] = await database.insert(schema.adminApprovalRequests).values({
      requesterUserId: requesterId, requesterAdminSessionId: requesterSessionId,
      requestId: "00000000-0000-4000-8000-000000000092", ipHash: "9".repeat(64),
      action: input.action, requestPermission: "exports.sensitive.request", approvalPermission: "exports.sensitive.approve",
      targetType: input.targetType, targetId: input.targetId, payloadVersion: 1, payload: input.payload,
      payloadHash: approvalHash(input), reason: input.reason, status: "pending",
      expiresAt: new Date(WORKER_NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    await repository.claim({ limit: 1, now: new Date(WORKER_NOW.getTime() + 61_000), leaseMs: 500 });
    expect((await database.select({ status: schema.adminApprovalRequests.status }).from(schema.adminApprovalRequests)
      .where(eq(schema.adminApprovalRequests.id, pending!.id)))[0]!.status).toBe("expired");
    expect(await database.select({ eventType: schema.adminOutboxEvents.eventType }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.approvalRequestId, pending!.id)))
      .toEqual([{ eventType: "admin.sensitive_export.expired" }]);
    expect(await database.select().from(schema.adminAuditLogs)
      .where(eq(schema.adminAuditLogs.requestId, "00000000-0000-4000-8000-000000000092"))).toHaveLength(1);
  });

  it("retries bulk items independently and converges successful idempotent replays", async () => {
    await database.update(schema.adminRoleAssignments).set({ role: "safety" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    await database.update(schema.adminRoleAssignments).set({ role: "safety" })
      .where(eq(schema.adminRoleAssignments.userId, approverId));
    const targets = await database.insert(schema.users).values([
      { name: "bulk-target-1", email: "bulk-target-1@example.test", emailVerified: true },
      { name: "bulk-target-2", email: "bulk-target-2@example.test", emailVerified: true },
      { name: "bulk-target-3", email: "bulk-target-3@example.test", emailVerified: true },
    ]).returning();
    const profiles = await database.insert(schema.profiles).values(targets.map((target) => ({ userId: target.id }))).returning();
    const reports = await database.insert(schema.reports).values(targets.map((target, index) => ({
      reporterUserId: requesterId, targetUserId: target.id, targetProfileId: profiles[index]!.id,
      targetType: "profile", reasonCode: "SCAM_OR_FRAUD", locale: "en-US", explanation: "coordinated abuse",
      clientId: `00000000-0000-4000-8000-00000000008${index}`, requestHash: String(index + 4).repeat(64),
      dedupeKey: String(index + 6).repeat(64), targetSnapshot: { schemaVersion: 1 as const, targetType: "profile" as const,
        targetUserId: target.id, targetProfileId: profiles[index]!.id, capturedAt: NOW.toISOString(),
        displayName: null, messageId: null, conversationId: null },
    }))).returning();
    const cases = await database.insert(schema.moderationCases).values(reports.map((report) => ({ reportId: report.id }))).returning();
    const input = normalizeAndDeriveApproval({ action: "bulk_suspension", payloadVersion: 1,
      payload: { reasonCode: "coordinated abuse", targets: targets.map((target, index) => ({ userId: target.id,
        caseId: cases[index]!.id, expectedVersion: 0, durationHours: 24 })) }, reason: "coordinated abuse" });
    for (const unsafeReasonCode of [null, "37.7749,-122.4194"]) {
      const unsafePayload = { ...input.payload, reasonCode: unsafeReasonCode };
      const unsafeBound = { action: input.action, targetType: input.targetType, targetId: input.targetId,
        payloadVersion: 1, payload: unsafePayload };
      await expect(database.insert(schema.adminApprovalRequests).values({ requesterUserId: requesterId,
        requesterAdminSessionId: requesterSessionId, requestId: "00000000-0000-4000-8000-000000000070",
        ipHash: "7".repeat(64), action: input.action, requestPermission: "users.bulk_suspend.request",
        approvalPermission: "users.bulk_suspend.approve", targetType: input.targetType, targetId: input.targetId,
        payloadVersion: 1, payload: unsafePayload, payloadHash: approvalHash(unsafeBound),
        reason: input.reason, status: "pending", expiresAt: new Date(WORKER_NOW.getTime() + 10 * 60_000),
        createdAt: NOW, updatedAt: NOW,
      })).rejects.toThrow();
    }
    const [request] = await database.insert(schema.adminApprovalRequests).values({ requesterUserId: requesterId,
      requesterAdminSessionId: requesterSessionId, requestId: "00000000-0000-4000-8000-000000000093",
      ipHash: "a".repeat(64), action: input.action, requestPermission: "users.bulk_suspend.request",
      approvalPermission: "users.bulk_suspend.approve", targetType: input.targetType, targetId: input.targetId,
      payloadVersion: 1, payload: input.payload, payloadHash: approvalHash(input), reason: input.reason,
      status: "pending", expiresAt: new Date(WORKER_NOW.getTime() + 10 * 60_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request!.id, approverUserId: approverId,
      approverAdminSessionId: approverSessionId, permission: "users.bulk_suspend.approve", decision: "approved",
      reason: "independent batch review", createdAt: NOW });
    const calls = new Map<string, number>();
    const applyUserAction = vi.fn(async ({ targetUserId }: { targetUserId: string }) => {
      const attempts = (calls.get(targetUserId) ?? 0) + 1; calls.set(targetUserId, attempts);
      if ((targetUserId === targets[1]!.id && attempts === 1) || targetUserId === targets[2]!.id) {
        throw new Error("temporary governance outage");
      }
      return { actionId: targetUserId === targets[0]!.id ? "00000000-0000-4000-8000-000000000091"
        : "00000000-0000-4000-8000-000000000092", status: "suspend", version: 1, replayed: attempts > 1 };
    });
    const repository = new DrizzleAdminApprovalExecutionRepository(database as never, { applyUserAction } as never,
      { createRefund: vi.fn() }, { putEncrypted: vi.fn() } as never);
    expect((await new AdminApprovalWorker(repository, { now: () => WORKER_NOW }).run(10)).retried).toBe(1);
    let items = await database.select().from(schema.adminBulkActionItems)
      .where(eq(schema.adminBulkActionItems.approvalRequestId, request!.id));
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetUserId: targets[0]!.id, status: "executed", attempts: 1,
        resultActionId: "00000000-0000-4000-8000-000000000091" }),
      expect.objectContaining({ targetUserId: targets[1]!.id, status: "retry", attempts: 1,
        lastErrorCode: "ADMIN_BULK_ITEM_RETRY" }),
      expect.objectContaining({ targetUserId: targets[2]!.id, status: "retry", attempts: 1,
        lastErrorCode: "ADMIN_BULK_ITEM_RETRY" }),
    ]));
    expect((await database.select({ eventType: schema.adminOutboxEvents.eventType }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.approvalRequestId, request!.id))).map((row) => row.eventType))
      .toEqual(expect.arrayContaining(["admin.bulk_suspension.item.executed", "admin.bulk_suspension.item.retry"]));
    for (const offset of [10_000, 20_000, 40_000]) {
      expect((await new AdminApprovalWorker(repository,
        { now: () => new Date(WORKER_NOW.getTime() + offset) }).run(10)).retried).toBe(1);
    }
    expect((await new AdminApprovalWorker(repository,
      { now: () => new Date(WORKER_NOW.getTime() + 80_000) }).run(10)).manualReview).toBe(1);
    items = await database.select().from(schema.adminBulkActionItems)
      .where(eq(schema.adminBulkActionItems.approvalRequestId, request!.id));
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetUserId: targets[0]!.id, status: "executed", attempts: 1 }),
      expect.objectContaining({ targetUserId: targets[1]!.id, status: "executed", attempts: 2 }),
      expect.objectContaining({ targetUserId: targets[2]!.id, status: "manual_review", attempts: 5,
        lastErrorCode: "ADMIN_BULK_ITEM_MANUAL_REVIEW" }),
    ]));
    expect(calls.get(targets[0]!.id)).toBe(1);
    expect(calls.get(targets[1]!.id)).toBe(2);
    expect(calls.get(targets[2]!.id)).toBe(5);
    expect((await database.select({ eventType: schema.adminOutboxEvents.eventType }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.approvalRequestId, request!.id))).map((row) => row.eventType))
      .toContain("admin.bulk_suspension.item.manual_review");
  });

  it("fences an expired bulk lease before the stale worker can commit an item result", async () => {
    await database.update(schema.adminRoleAssignments).set({ role: "safety" })
      .where(eq(schema.adminRoleAssignments.userId, requesterId));
    await database.update(schema.adminRoleAssignments).set({ role: "safety" })
      .where(eq(schema.adminRoleAssignments.userId, approverId));
    const [target] = await database.insert(schema.users).values({
      name: "lease-target", email: "lease-target@example.test", emailVerified: true,
    }).returning();
    const [profile] = await database.insert(schema.profiles).values({ userId: target!.id }).returning();
    const [report] = await database.insert(schema.reports).values({ reporterUserId: requesterId,
      targetUserId: target!.id, targetProfileId: profile!.id, targetType: "profile", reasonCode: "SCAM_OR_FRAUD",
      locale: "en-US", explanation: "coordinated abuse", clientId: "00000000-0000-4000-8000-000000000077",
      requestHash: "7".repeat(64), dedupeKey: "8".repeat(64), targetSnapshot: { schemaVersion: 1 as const,
        targetType: "profile" as const, targetUserId: target!.id, targetProfileId: profile!.id,
        capturedAt: NOW.toISOString(), displayName: null, messageId: null, conversationId: null },
    }).returning();
    const [moderationCase] = await database.insert(schema.moderationCases).values({ reportId: report!.id }).returning();
    const input = normalizeAndDeriveApproval({ action: "bulk_suspension", payloadVersion: 1,
      payload: { reasonCode: "coordinated abuse", targets: [{ userId: target!.id, caseId: moderationCase!.id,
        expectedVersion: 0, durationHours: 24 }] }, reason: "coordinated abuse" });
    const [request] = await database.insert(schema.adminApprovalRequests).values({ requesterUserId: requesterId,
      requesterAdminSessionId: requesterSessionId, requestId: "00000000-0000-4000-8000-000000000076",
      ipHash: "8".repeat(64), action: input.action, requestPermission: "users.bulk_suspend.request",
      approvalPermission: "users.bulk_suspend.approve", targetType: input.targetType, targetId: input.targetId,
      payloadVersion: 1, payload: input.payload, payloadHash: approvalHash(input), reason: input.reason,
      status: "pending", expiresAt: new Date(WORKER_NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request!.id, approverUserId: approverId,
      approverAdminSessionId: approverSessionId, permission: "users.bulk_suspend.approve", decision: "approved",
      reason: "independent batch review", createdAt: NOW });
    const recoveredAction = "00000000-0000-4000-8000-000000000074";
    const applyUserAction = vi.fn(async () => {
      await database.update(schema.adminApprovalRequests).set({
        leaseExpiresAt: new Date(NOW.getTime() - 1_000) })
        .where(eq(schema.adminApprovalRequests.id, request!.id));
      return { actionId: recoveredAction, status: "suspend", version: 1, replayed: false };
    });
    const repository = new DrizzleAdminApprovalExecutionRepository(database as never, { applyUserAction } as never,
      { createRefund: vi.fn() }, { putEncrypted: vi.fn() } as never);
    await new AdminApprovalWorker(repository, { now: () => WORKER_NOW }).run(1);
    expect((await database.select({ status: schema.adminBulkActionItems.status,
      resultActionId: schema.adminBulkActionItems.resultActionId }).from(schema.adminBulkActionItems)
      .where(eq(schema.adminBulkActionItems.approvalRequestId, request!.id)))[0])
      .toEqual({ status: "claimed", resultActionId: null });
  });

  it("persists a provider refund result before finalize and recovers without a second provider call", async () => {
    await database.insert(schema.billingWebhookEvents).values({ providerEventId: "evt-admin-refund-1",
      eventType: "invoice.payment_succeeded", payloadHash: "7".repeat(64), objectId: "invoice-admin-refund-1",
      providerCreatedAt: NOW, outcome: "applied", processedAt: NOW });
    const [payment] = await database.insert(schema.billingPayments).values({
      providerInvoiceId: "invoice-admin-refund-1", providerPaymentId: "pi-admin-refund-1",
      providerEventId: "evt-admin-refund-1", amount: 2500, currency: "USD", paidAt: NOW,
    }).returning();
    const input = normalizeAndDeriveApproval({ action: "manual_refund", payloadVersion: 1,
      payload: { paymentId: payment!.id, amount: 1250 }, reason: "verified duplicate charge" });
    const [request] = await database.insert(schema.adminApprovalRequests).values({ requesterUserId: requesterId,
      requesterAdminSessionId: requesterSessionId, requestId: "00000000-0000-4000-8000-000000000090",
      ipHash: "8".repeat(64), action: input.action, requestPermission: "billing.refund.request",
      approvalPermission: "billing.refund.approve", targetType: input.targetType, targetId: input.targetId,
      payloadVersion: 1, payload: input.payload, payloadHash: approvalHash(input), reason: input.reason,
      status: "pending", expiresAt: new Date(WORKER_NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW,
    }).returning();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request!.id, approverUserId: approverId,
      approverAdminSessionId: approverSessionId, permission: "billing.refund.approve", decision: "approved",
      reason: "independent payment review", createdAt: NOW });
    let finishProvider!: (value: { providerRefundId: string }) => void;
    const createRefund = vi.fn(() => new Promise<{ providerRefundId: string }>((resolve) => { finishProvider = resolve; }));
    const repository = new DrizzleAdminApprovalExecutionRepository(database as never, { applyUserAction: vi.fn() },
      { createRefund }, { putEncrypted: vi.fn() } as never);
    const [claim] = await repository.claim({ limit: 1, now: WORKER_NOW, leaseMs: 500 });
    const execution = repository.execute(claim!, WORKER_NOW);
    await vi.waitFor(() => expect(createRefund).toHaveBeenCalledTimes(1));
    await database.update(schema.adminApprovalRequests).set({ leaseId: "00000000-0000-4000-8000-000000000089",
      leaseExpiresAt: new Date(NOW.getTime() - 1_000) }).where(eq(schema.adminApprovalRequests.id, request!.id));
    finishProvider({ providerRefundId: "re-admin-refund-1" });
    await expect(execution).resolves.toBe("retry");
    expect((await database.select({ providerRefundId: schema.adminRefundIntents.providerRefundId })
      .from(schema.adminRefundIntents).where(eq(schema.adminRefundIntents.approvalRequestId, request!.id)))[0]!.providerRefundId)
      .toBe("re-admin-refund-1");
    const recovered = await repository.claim({ limit: 1, now: new Date(WORKER_NOW.getTime() + 1_000), leaseMs: 500 });
    expect(recovered).toHaveLength(1);
    await expect(repository.execute(recovered[0]!, new Date(WORKER_NOW.getTime() + 1_000))).resolves.toBe("executed");
    expect(createRefund).toHaveBeenCalledTimes(1);
  });

  it("cannot approve expired or rejected requests or mutate immutable payloads", async () => {
    const expired = await createApproval(new Date(Date.now() + 200));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(database.insert(schema.adminApprovalDecisions).values({
      requestId: expired.id, approverUserId: approverId, approverAdminSessionId: approverSessionId,
      permission: "billing.refund.approve",
      decision: "approved", reason: "too late", createdAt: new Date(),
    })).rejects.toThrow();
    await expect(database.update(schema.adminApprovalRequests).set({ payloadHash: "b".repeat(64) })
      .where(eq(schema.adminApprovalRequests.id, expired.id))).rejects.toThrow();
  });

  it("keeps audit, decisions, config changes and idempotency append-only", async () => {
    const request = await createApproval();
    const [audit] = await database.insert(schema.adminAuditLogs).values({
      actorUserId: approverId, permission: "billing.refund.approve", targetType: "payment", targetId: "payment-1",
      beforeDiff: { status: "pending" }, afterDiff: { status: "approved" }, reason: "ledger reviewed",
      requestId: "00000000-0000-4000-8000-000000000001", ipHash: "b".repeat(64), createdAt: NOW,
    }).returning();
    await expect(database.delete(schema.adminAuditLogs).where(eq(schema.adminAuditLogs.id, audit!.id))).rejects.toThrow();
    await database.insert(schema.adminApprovalDecisions).values({ requestId: request.id, approverUserId: approverId,
      approverAdminSessionId: approverSessionId,
      permission: "billing.refund.approve", decision: "rejected", reason: "amount mismatch", createdAt: NOW });
    const [decision] = await database.select().from(schema.adminApprovalDecisions);
    await expect(database.update(schema.adminApprovalDecisions).set({ reason: "rewritten" })
      .where(eq(schema.adminApprovalDecisions.id, decision!.id))).rejects.toThrow();
  });

  it("records request, decision and claim transitions with pending outbox delivery", async () => {
    const approvals = new DrizzleApprovalRepository(database as never, "h".repeat(32));
    const service = new AdminService({ approvals, governance: { applyUserAction: vi.fn() },
      entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW });
    const created = await service.requestSensitiveAction({ userId: requesterId, adminSessionId: requesterSessionId,
      role: "finance", mfaVerifiedAt: NOW }, { action: "manual_refund", payloadVersion: 1,
      payload: { paymentId: PAYMENT_ID, amount: 1000 }, reason: "verified duplicate charge" },
    { requestId: "00000000-0000-4000-8000-000000000073", ipAddress: "203.0.113.10" });
    const approvalId = created.id!;
    await service.decideApproval({ userId: approverId, adminSessionId: approverSessionId,
      role: "finance", mfaVerifiedAt: NOW }, approvalId, "approved", "independent ledger review",
    { requestId: "00000000-0000-4000-8000-000000000072", ipAddress: "203.0.113.11" });
    const execution = new DrizzleAdminApprovalExecutionRepository(database as never,
      { applyUserAction: vi.fn() }, { createRefund: vi.fn() }, { putEncrypted: vi.fn() } as never);
    expect(await execution.claim({ limit: 1, now: WORKER_NOW, leaseMs: 30_000 })).toHaveLength(1);
    expect(await database.select({ eventType: schema.adminOutboxEvents.eventType,
      status: schema.adminOutboxEvents.status }).from(schema.adminOutboxEvents)
      .where(eq(schema.adminOutboxEvents.approvalRequestId, approvalId)))
      .toEqual(expect.arrayContaining([
        { eventType: "admin.manual_refund.requested", status: "pending" },
        { eventType: "admin.manual_refund.approved", status: "pending" },
        { eventType: "admin.manual_refund.executing", status: "pending" },
      ]));
    expect(await database.select().from(schema.adminAuditLogs)
      .where(eq(schema.adminAuditLogs.targetId, PAYMENT_ID))).toHaveLength(3);
  });

  it("uses one target-version CAS and replays the same action across request tracing metadata", async () => {
    const [target] = await database.insert(schema.users).values({
      name: "governance-target", email: "governance-target@admin.example", emailVerified: true,
    }).returning();
    const [profile] = await database.insert(schema.profiles).values({ userId: target!.id,
      displayName: "Governance target", birthDate: "1990-01-01", genderCode: "person",
      relationshipGoalCode: "long_term", countryCode: "US", city: "Seattle", timeZone: "UTC",
      status: "active", discoverable: true }).returning();
    const [report] = await database.insert(schema.reports).values({ reporterUserId: approverId,
      targetUserId: target!.id, targetProfileId: profile!.id, targetType: "profile", reasonCode: "HARASSMENT",
      locale: "en-US", explanation: "atomic governance fixture",
      clientId: "00000000-0000-4000-8000-000000000077", requestHash: "1".repeat(64), dedupeKey: "2".repeat(64),
      targetSnapshot: { schemaVersion: 1, targetType: "profile", targetUserId: target!.id,
        targetProfileId: profile!.id, capturedAt: NOW.toISOString(), displayName: "Governance target",
        messageId: null, conversationId: null }, createdAt: NOW, updatedAt: NOW }).returning();
    const [moderationCase] = await database.insert(schema.moderationCases).values({ reportId: report!.id,
      status: "under_review", assignedWorkerUserId: requesterId, createdAt: NOW, updatedAt: NOW }).returning();
    const caseService = new DrizzleCaseService(database, { clock: () => NOW,
      resolveEvidenceReaderRole: async () => null });
    const projection = new DrizzleAdminGovernanceProjection(database as never, caseService, "h".repeat(32), () => NOW);
    const base = { actorUserId: requesterId, actorRole: "safety" as const,
      targetUserId: target!.id, action: "suspend" as const,
      caseId: moderationCase!.id, reason: "confirmed policy violation", expectedVersion: 0, durationHours: 24 };
    const keys = ["governance-action-0001", "governance-action-0002"];
    const concurrent = await Promise.allSettled(keys.map(
      (idempotencyKey) => projection.applyUserAction({ ...base, idempotencyKey,
        context: { requestId: "00000000-0000-4000-8000-000000000071", ipAddress: "203.0.113.8" } }),
    ));
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winnerIndex = concurrent.findIndex((result) => result.status === "fulfilled");
    const first = (concurrent[winnerIndex] as PromiseFulfilledResult<unknown>).value;
    await expect(projection.applyUserAction({ ...base, idempotencyKey: keys[winnerIndex]!,
      context: { requestId: "00000000-0000-4000-8000-000000000072", ipAddress: "203.0.113.9" } }))
      .resolves.toEqual({ ...(first as Record<string, unknown>), replayed: true });
    expect(await database.select().from(schema.moderationActions)
      .where(eq(schema.moderationActions.caseId, moderationCase!.id))).toHaveLength(1);
    expect(await database.select().from(schema.adminAuditLogs)
      .where(eq(schema.adminAuditLogs.targetId, target!.id))).toHaveLength(1);
  });

  it("persists a route-validated global_flag through the real Task7 versioned configuration", async () => {
    const [operator] = await database.insert(schema.users).values({
      name: "configuration-operator", email: "configuration-operator@admin.example", emailVerified: true,
    }).returning();
    const [assignment] = await database.insert(schema.adminRoleAssignments).values({
      userId: operator!.id, role: "super_admin", active: "active", createdAt: NOW,
    }).returning();
    const [session] = await database.insert(schema.adminSessions).values({ userId: operator!.id,
      roleAssignmentId: assignment!.id, tokenHash: "4".repeat(64), mfaVerifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), lastSeenAt: new Date() }).returning();
    const service = new AdminService({ approvals: { create: async () => { throw new Error("unused"); } },
      governance: { applyUserAction: async () => { throw new Error("unused"); } },
      entitlementConfig: new DrizzleVersionedEntitlementConfiguration(database as never, "h".repeat(32)),
      clock: () => NOW });
    const handler = createAdminEntitlementsHandler({ service,
      getSession: async () => ({ userId: operator!.id, adminSessionId: session!.id, role: "super_admin",
        mfaVerifiedAt: NOW }), limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      isTrustedOrigin: () => true, resolveClientIp: () => "203.0.113.20", now: () => NOW,
      createTraceId: () => "00000000-0000-4000-8000-000000000066" });
    const response = await handler(new Request("https://app.example/api/v1/admin/entitlements", { method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example",
        "idempotency-key": "global-flag-route-0001" }, body: JSON.stringify({ entitlementKey: "message.send.daily",
        scope: "global_flag", expectedVersion: 0, reason: "temporary safety shutdown",
        grant: { kind: "quota", enabled: false, booleanValue: null, quotaLimit: null,
          numericValue: null, upgradeHint: null } }) }));
    expect(response.status).toBe(201);
    for (const [entitlementKey, kind, idempotencyKey] of [
      ["message.read_receipt.view", "boolean", "global-flag-route-0002"],
      ["ranking.boost.multiplier", "numeric", "global-flag-route-0003"],
    ] as const) {
      const kindResponse = await handler(new Request("https://app.example/api/v1/admin/entitlements", { method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ entitlementKey, scope: "global_flag", expectedVersion: 0,
          reason: "temporary global availability control", grant: { kind, enabled: true,
            booleanValue: null, quotaLimit: null, numericValue: null, upgradeHint: null } }) }));
      expect(kindResponse.status).toBe(201);
    }
    expect(await database.select({ scope: schema.entitlementConfigurations.scope,
      booleanValue: schema.entitlementConfigurations.booleanValue,
      quotaLimit: schema.entitlementConfigurations.quotaLimit,
      numericValue: schema.entitlementConfigurations.numericValue,
      upgradeHint: schema.entitlementConfigurations.upgradeHint,
    }).from(schema.entitlementConfigurations).where(and(
      eq(schema.entitlementConfigurations.entitlementKey, "message.send.daily"),
      eq(schema.entitlementConfigurations.scope, "global_flag"),
    ))).toEqual([{ scope: "global_flag", booleanValue: null,
      quotaLimit: null, numericValue: null, upgradeHint: null }]);
    expect(await database.select({ kind: schema.entitlementConfigurations.kind,
      enabled: schema.entitlementConfigurations.enabled }).from(schema.entitlementConfigurations)
      .where(eq(schema.entitlementConfigurations.scope, "global_flag")))
      .toEqual(expect.arrayContaining([{ kind: "quota", enabled: false }, { kind: "boolean", enabled: true },
        { kind: "numeric", enabled: true }]));
  });
});
