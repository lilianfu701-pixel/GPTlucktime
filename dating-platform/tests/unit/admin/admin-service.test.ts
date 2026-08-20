import { describe, expect, it, vi } from "vitest";

import { AdminService, type ApprovalRequest } from "@/modules/admin/admin-service";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const actor = (id: string, role: "safety" | "finance" | "operations" | "super_admin") => ({
  userId: id, adminSessionId: "00000000-0000-4000-8000-000000000099", role,
  mfaVerifiedAt: new Date(NOW.getTime() - 60_000),
});
const requestContext = { requestId: "00000000-0000-4000-8000-000000000098", ipAddress: "203.0.113.8" };

describe("AdminService", () => {
  it("binds sensitive requests to an immutable canonical payload hash and version", async () => {
    const create = vi.fn(async (request: Omit<ApprovalRequest, "ipHash">) => ({ ...request, ipHash: "a".repeat(64) }));
    const service = new AdminService({
      approvals: { create },
      governance: { applyUserAction: vi.fn() }, entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW,
    });
    const result = await service.requestSensitiveAction(actor("00000000-0000-4000-8000-000000000001", "safety"), {
      action: "bulk_suspension", payloadVersion: 1, payload: { targets: [
        { userId: "00000000-0000-4000-8000-000000000004", caseId: "00000000-0000-4000-8000-000000000014", expectedVersion: 2, durationHours: 24 },
        { userId: "00000000-0000-4000-8000-000000000003", caseId: "00000000-0000-4000-8000-000000000013", expectedVersion: 1, durationHours: 24 },
      ], reasonCode: "coordinated abuse" }, reason: "coordinated abuse",
    }, requestContext);
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      requesterUserId: "00000000-0000-4000-8000-000000000001", requestPermission: "users.bulk_suspend.request",
      approvalPermission: "users.bulk_suspend.approve", payloadVersion: 1,
      targetType: "user_batch", targetId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      status: "pending", expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    }), requestContext);
  });

  it("binds a safety evidence grant to the requesting admin actor", async () => {
    const create = vi.fn();
    const service = new AdminService({ approvals: { create }, governance: { applyUserAction: vi.fn() },
      entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW });
    await expect(service.requestSensitiveAction(actor("requester", "safety"), {
      action: "safety_evidence_access", payloadVersion: 1,
      payload: { actorUserId: "other", caseId: "case-1", reportId: "report-1", evidenceId: "evidence-1",
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString() }, reason: "active safety investigation",
    }, requestContext)).rejects.toThrow("INVALID_APPROVAL");
    expect(create).not.toHaveBeenCalled();
  });

  it("derives every approval target from the validated action payload and rejects duplicate bulk users", async () => {
    const create = vi.fn(async (request: Omit<ApprovalRequest, "ipHash">) => ({ ...request, ipHash: "a".repeat(64) }));
    const service = new AdminService({ approvals: { create }, governance: { applyUserAction: vi.fn() },
      entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW });
    const cases = [
      ["manual_refund", { paymentId: "00000000-0000-4000-8000-000000000010", amount: 100 }, "payment", "00000000-0000-4000-8000-000000000010"],
      ["payment_configuration", { planId: "00000000-0000-4000-8000-000000000011", expectedVersion: 2,
        countryCode: "US", currency: "USD", unitAmount: 999, interval: "monthly", intervalCount: 1,
        taxMode: "exclusive", providerPriceId: "price_safe_ref", effectiveAt: "2026-08-14T12:05:00.000Z" },
      "billing_price", "00000000-0000-4000-8000-000000000011:US:USD"],
      ["sensitive_export", { exportKind: "billing_ledger", scope: { subjectUserId: "00000000-0000-4000-8000-000000000012" } },
        "export_scope", expect.stringMatching(/^[a-f0-9]{64}$/u)],
    ] as const;
    for (const [action, payload, targetType, targetId] of cases) {
      await service.requestSensitiveAction(actor("00000000-0000-4000-8000-000000000001", "super_admin"),
        { action, payloadVersion: 1, payload, reason: "independent bounded review" } as never, requestContext);
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ targetType, targetId }), requestContext);
    }
    const duplicate = { userId: "00000000-0000-4000-8000-000000000020",
      caseId: "00000000-0000-4000-8000-000000000021", expectedVersion: 0, durationHours: 24 };
    await expect(service.requestSensitiveAction(actor("00000000-0000-4000-8000-000000000001", "safety"), {
      action: "bulk_suspension", payloadVersion: 1,
      payload: { targets: [duplicate, duplicate], reasonCode: "coordinated abuse" }, reason: "coordinated abuse",
    }, requestContext)).rejects.toThrow("INVALID_APPROVAL");
  });

  it("requires recent MFA and returns an action-specific safe approval preview", async () => {
    const get = vi.fn(async (): Promise<Record<string, unknown>> => ({ requesterUserId: "requester", approvalPermission: "billing.refund.approve",
      action: "manual_refund", targetType: "payment", targetId: "00000000-0000-4000-8000-000000000010",
      payload: { paymentId: "00000000-0000-4000-8000-000000000010", amount: 1250 },
      currency: "USD", rawMessage: "must not escape", status: "pending", payloadHash: "a".repeat(64) }));
    const service = new AdminService({ approvals: { create: vi.fn(), get }, governance: { applyUserAction: vi.fn() },
      entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW });
    await expect(service.getApprovalRequest({ ...actor("approver", "finance"),
      mfaVerifiedAt: new Date(NOW.getTime() - 10 * 60_000) }, "approval-id")).rejects.toThrow("RECENT_MFA_REQUIRED");
    expect(get).toHaveBeenCalledTimes(0);
    const detail = await service.getApprovalRequest(actor("approver", "finance"), "approval-id");
    expect(detail).toEqual(expect.objectContaining({ preview: {
      paymentId: "00000000-0000-4000-8000-000000000010", amount: 1250, currency: "USD",
    } }));
    expect(JSON.stringify(detail)).not.toContain("rawMessage");
    get.mockResolvedValueOnce({ requesterUserId: "requester", approvalPermission: "users.bulk_suspend.approve",
      action: "bulk_suspension", targetType: "user_batch", targetId: "b".repeat(64),
      payload: { targets: [{ userId: "00000000-0000-4000-8000-000000000020",
        caseId: "00000000-0000-4000-8000-000000000021", expectedVersion: 3, durationHours: 24 }],
      reasonCode: "coordinated abuse" }, status: "pending", payloadHash: "b".repeat(64) });
    expect((await service.getApprovalRequest(actor("approver", "safety"), "approval-id"))).toEqual(
      expect.objectContaining({ preview: expect.objectContaining({ reasonCode: "coordinated abuse" }) }));
  });

  it("rejects self approval, missing permission, and stale MFA before repository execution", async () => {
    const decide = vi.fn();
    const get = vi.fn(async () => ({ requesterUserId: "requester", approvalPermission: "billing.refund.approve" }));
    const service = new AdminService({
      approvals: { create: vi.fn(), decide, get }, governance: { applyUserAction: vi.fn() },
      entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW,
    });
    await expect(service.decideApproval(actor("requester", "finance"), "approval-1", "approved",
      "independent review", requestContext))
      .rejects.toThrow("SELF_APPROVAL_FORBIDDEN");
    await expect(service.decideApproval(actor("other", "operations"), "approval-1", "approved",
      "independent review", requestContext))
      .rejects.toThrow("FORBIDDEN");
    await expect(service.decideApproval({ ...actor("other", "finance"),
      mfaVerifiedAt: new Date(NOW.getTime() - 10 * 60_000) }, "approval-1", "approved",
      "independent review", requestContext))
      .rejects.toThrow("RECENT_MFA_REQUIRED");
    expect(decide).not.toHaveBeenCalled();
  });

  it("delegates one-time concurrent approval and execution to the atomic repository", async () => {
    const decide = vi.fn(async () => ({ status: "approved" as const, replayed: false }));
    const get = vi.fn(async () => ({ requesterUserId: "requester", approvalPermission: "billing.refund.approve" }));
    const service = new AdminService({
      approvals: { create: vi.fn(), decide, get }, governance: { applyUserAction: vi.fn() },
      entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW,
    });
    const result = await service.decideApproval(actor("approver", "finance"), "approval-1", "approved",
      "verified payment ledger", requestContext);
    expect(result).toEqual({ status: "approved", replayed: false });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-1", approverUserId: "approver",
      approverAdminSessionId: "00000000-0000-4000-8000-000000000099",
      reason: "verified payment ledger", now: NOW, context: requestContext,
    }));
  });

  it("reuses the official governance projection for user status actions", async () => {
    const applyUserAction = vi.fn(async () => ({ status: "suspended", version: 8, replayed: false }));
    const service = new AdminService({
      approvals: { create: vi.fn() }, governance: { applyUserAction },
      entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW,
    });
    await service.applyUserStatusAction(actor("operator", "safety"), "user-1", {
      action: "suspend", caseId: "case-1", reason: "confirmed safety violation",
      idempotencyKey: "status-change-1234", expectedVersion: 7, durationHours: 24,
    }, requestContext);
    expect(applyUserAction).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "operator", targetUserId: "user-1", action: "suspend", caseId: "case-1",
      actorRole: "safety", reason: "confirmed safety violation", idempotencyKey: "status-change-1234", expectedVersion: 7,
    }));
  });

  it("reuses Task7 versioned configuration and never performs an unversioned overwrite", async () => {
    const appendVersion = vi.fn(async () => ({ version: 4, replayed: false }));
    const service = new AdminService({
      approvals: { create: vi.fn() }, governance: { applyUserAction: vi.fn() },
      entitlementConfig: { appendVersion }, clock: () => NOW,
    });
    await service.updateEntitlementConfiguration(actor("operator", "super_admin"), {
      entitlementKey: "message.send.daily", scope: "free_default", expectedVersion: 3,
      idempotencyKey: "ent-config-1234", reason: "launch quota adjustment",
      grant: { kind: "quota", enabled: true, quotaLimit: 20, booleanValue: null, numericValue: null,
        upgradeHint: "plans.plus" },
    }, requestContext);
    expect(appendVersion).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 3,
      nextVersion: 4, actorUserId: "operator", effectiveAt: NOW, context: requestContext }));
  });

  it("filters bounded queues by permission without exposing forbidden counts", async () => {
    const listQueue = vi.fn(async ({ queue }: { queue: string }) => ({
      items: [{ id: `${queue}-1`, status: "pending", createdAt: NOW.toISOString() }], nextCursor: null,
    }));
    const service = new AdminService({
      approvals: { create: vi.fn() }, governance: { applyUserAction: vi.fn() },
      entitlementConfig: { appendVersion: vi.fn() }, queues: { listQueue }, clock: () => NOW,
    });
    const result = await service.listQueues(actor("finance", "finance"), { limit: 10 });
    expect(Object.keys(result)).toEqual(["billing_discrepancies", "configuration_changes"]);
    expect(listQueue).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("total");
    await expect(service.listQueues(actor("finance", "finance"), { limit: 51 })).rejects.toThrow("INVALID_CURSOR");
  });

  it("passes only server-derived approval permissions to list and detail repositories", async () => {
    const list = vi.fn(async () => ({ items: [], nextCursor: null }));
    const get = vi.fn(async () => null);
    const service = new AdminService({ approvals: { create: vi.fn(), list, get },
      governance: { applyUserAction: vi.fn() }, entitlementConfig: { appendVersion: vi.fn() }, clock: () => NOW });
    await service.listApprovalRequests(actor("finance", "finance"), { limit: 10 });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ allowedApprovalPermissions: expect.arrayContaining([
      "billing.refund.approve", "billing.config.approve",
    ]) }));
    await expect(service.getApprovalRequest(actor("finance", "finance"), "approval-id")).rejects.toThrow("ACTION_NOT_AVAILABLE");
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ allowedApprovalPermissions: expect.arrayContaining([
      "billing.refund.approve", "billing.config.approve",
    ]) }));
  });
});
