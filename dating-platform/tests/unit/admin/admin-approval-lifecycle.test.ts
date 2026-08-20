import { describe, expect, it, vi } from "vitest";

import {
  createAdminApprovalCollectionHandler,
  createAdminApprovalDecisionHandler,
  createAdminApprovalDetailHandler,
} from "@/modules/admin/admin-route";
import { createAdminApprovalWorkerRoute } from "@/modules/admin/admin-worker-route";
import type { AdminActor } from "@/modules/admin/admin-service";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const TRACE = "00000000-0000-4000-8000-000000000099";
const actor: AdminActor = {
  userId: "00000000-0000-4000-8000-000000000001",
  adminSessionId: "00000000-0000-4000-8000-000000000002",
  role: "safety",
  mfaVerifiedAt: new Date(NOW.getTime() - 60_000),
};
const common = () => ({
  getSession: vi.fn(async () => actor),
  limiter: { consume: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) },
  isTrustedOrigin: vi.fn(() => true),
  resolveClientIp: vi.fn(() => "203.0.113.8"),
  now: () => NOW,
  createTraceId: () => TRACE,
});

describe("admin approval production lifecycle", () => {
  it("supports bounded request/list/detail routes using the authoritative admin session", async () => {
    const dependencies = common();
    const service = {
      requestSensitiveAction: vi.fn(async () => ({ id: "approval", status: "pending" })),
      listApprovalRequests: vi.fn(async () => ({ items: [], nextCursor: null })),
      getApprovalRequest: vi.fn(async () => ({ id: "approval", action: "safety_evidence_access", status: "pending" })),
    };
    const collection = createAdminApprovalCollectionHandler({ ...dependencies, service });
    const request = new Request("https://app.example/api/v1/admin/approvals", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ action: "safety_evidence_access", payloadVersion: 1,
        payload: { actorUserId: actor.userId, caseId: "00000000-0000-4000-8000-000000000010",
          reportId: "00000000-0000-4000-8000-000000000013", evidenceId: "00000000-0000-4000-8000-000000000011",
          expiresAt: "2026-08-14T12:10:00.000Z" }, reason: "active safety investigation" }),
    });
    expect((await collection(request)).status).toBe(201);
    expect(service.requestSensitiveAction).toHaveBeenCalledWith(actor, expect.anything(), {
      requestId: TRACE, ipAddress: "203.0.113.8",
    });

    expect((await collection(new Request("https://app.example/api/v1/admin/approvals?limit=20", { method: "GET" }))).status).toBe(200);
    const detail = createAdminApprovalDetailHandler({ ...dependencies, service });
    expect((await detail(new Request("https://app.example/api/v1/admin/approvals/00000000-0000-4000-8000-000000000012", { method: "GET" }),
      { params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000012" }) })).status).toBe(200);
  });

  it("requires a distinct recent-MFA session for approve/reject and passes its real session id", async () => {
    const dependencies = common();
    const decideApproval = vi.fn(async () => ({ status: "approved", replayed: false }));
    const handler = createAdminApprovalDecisionHandler({ ...dependencies, service: { decideApproval } });
    const response = await handler(new Request("https://app.example/api/v1/admin/approvals/a/approve", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ decision: "approved", reason: "independently verified" }),
    }), { params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000012" }) });
    expect(response.status).toBe(200);
    expect(decideApproval).toHaveBeenCalledWith(actor, "00000000-0000-4000-8000-000000000012",
      "approved", "independently verified", { requestId: TRACE, ipAddress: "203.0.113.8" });
  });

  it("maps self approval to the stable non-enumerating forbidden response", async () => {
    const dependencies = common();
    const handler = createAdminApprovalDecisionHandler({ ...dependencies,
      service: { decideApproval: vi.fn(async () => { throw new Error("SELF_APPROVAL_FORBIDDEN"); }) } });
    const response = await handler(new Request("https://app.example/api/v1/admin/approvals/a/decision", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ decision: "approved", reason: "independently verified" }),
    }), { params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000012" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "FORBIDDEN", traceId: TRACE }));
  });

  it("rejects action payload fields outside the bounded immutable action contract", async () => {
    const dependencies = common();
    const requestSensitiveAction = vi.fn();
    const handler = createAdminApprovalCollectionHandler({ ...dependencies, service: { requestSensitiveAction } });
    const response = await handler(new Request("https://app.example/api/v1/admin/approvals", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ action: "manual_refund", targetType: "payment",
        targetId: "00000000-0000-4000-8000-000000000010", payloadVersion: 1,
        payload: { paymentId: "00000000-0000-4000-8000-000000000010", amount: 100, role: "super_admin" },
        reason: "verified duplicate charge" }),
    }));
    expect(response.status).toBe(400);
    expect(requestSensitiveAction).not.toHaveBeenCalled();
  });

  it("rejects caller-controlled approval targets and accepts only action-specific payloads", async () => {
    const dependencies = common();
    const requestSensitiveAction = vi.fn(async () => ({ id: "approval", status: "pending" }));
    const handler = createAdminApprovalCollectionHandler({ ...dependencies, service: { requestSensitiveAction } });
    const base = { action: "manual_refund", payloadVersion: 1,
      payload: { paymentId: "00000000-0000-4000-8000-000000000010", amount: 100 },
      reason: "verified duplicate charge" };
    const forged = await handler(new Request("https://app.example/api/v1/admin/approvals", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ ...base, targetType: "user", targetId: actor.userId }),
    }));
    expect(forged.status).toBe(400);
    const valid = await handler(new Request("https://app.example/api/v1/admin/approvals", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify(base),
    }));
    expect(valid.status).toBe(201);
    expect(requestSensitiveAction).toHaveBeenCalledTimes(1);
    const ambiguousSafety = await handler(new Request("https://app.example/api/v1/admin/approvals", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ action: "safety_evidence_access", payloadVersion: 1,
        payload: { actorUserId: actor.userId, caseId: "00000000-0000-4000-8000-000000000011",
          reportId: "00000000-0000-4000-8000-000000000012",
          evidenceId: "00000000-0000-4000-8000-000000000013",
          messageId: "00000000-0000-4000-8000-000000000014", expiresAt: "2026-08-14T12:10:00.000Z" },
        reason: "active safety investigation" }),
    }));
    expect(ambiguousSafety.status).toBe(400);
    expect(requestSensitiveAction).toHaveBeenCalledTimes(1);
  });

  it("authenticates the worker before invoking a bounded leased run", async () => {
    const run = vi.fn(async () => ({ claimed: 1, executed: 1, retried: 0, manualReview: 0 }));
    const handler = createAdminApprovalWorkerRoute({ secret: "a".repeat(32), run });
    expect((await handler(new Request("https://app.example/api/internal/workers/admin", { method: "GET" }))).status).toBe(405);
    expect(run).not.toHaveBeenCalled();
    expect((await handler(new Request("https://app.example/api/internal/workers/admin", { method: "POST",
      headers: { authorization: `Bearer ${"b".repeat(32)}` } }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect((await handler(new Request("https://app.example/api/internal/workers/admin", { method: "POST",
      headers: { authorization: `Bearer ${"a".repeat(32)}` } }))).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
