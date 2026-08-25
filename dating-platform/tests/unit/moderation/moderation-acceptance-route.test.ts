import { describe, expect, it, vi } from "vitest";

import {
  createAdminAppealDecisionHandler,
  createAdminAppealReviewHandler,
  createAdminCaseActionHandler,
  createAdminMediaDecisionHandler,
} from "@/modules/admin/admin-route";
import { createMemberAppealsHandler } from "@/modules/moderation/appeal-route";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const TRACE = "00000000-0000-4000-8000-000000000099";
const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  target: "00000000-0000-4000-8000-000000000002",
  case: "00000000-0000-4000-8000-000000000003",
  appeal: "00000000-0000-4000-8000-000000000004",
  job: "00000000-0000-4000-8000-000000000005",
};
const adminDeps = () => ({
  getSession: vi.fn(async () => ({ userId: ids.actor, adminSessionId: TRACE, role: "moderation" as const,
    mfaVerifiedAt: new Date(NOW.getTime() - 60_000) })),
  limiter: { consume: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) },
  isTrustedOrigin: vi.fn(() => true), resolveClientIp: vi.fn(() => "203.0.113.8"),
  now: () => NOW, createTraceId: () => TRACE,
});
const post = (path: string, body: unknown) => new Request(`https://app.example${path}`, { method: "POST",
  headers: { "content-type": "application/json", origin: "https://app.example", "idempotency-key": "moderation-action-123" },
  body: JSON.stringify(body) });

describe("moderation acceptance route adapters", () => {
  it("lets a moderator triage a case through the reports permission", async () => {
    const transitionCase = vi.fn(async () => ({ status: "triaged" }));
    const handler = createAdminCaseActionHandler({ ...adminDeps(), service: { transitionCase, restrictCase: vi.fn() } });
    const response = await handler(post(`/api/v1/admin/cases/${ids.case}/actions`, {
      action: "transition", nextStatus: "triaged",
    }), { params: Promise.resolve({ caseId: ids.case }) });
    expect(response.status).toBe(200);
    expect(transitionCase).toHaveBeenCalledWith(expect.objectContaining({ role: "moderation" }), ids.case, "triaged",
      expect.objectContaining({ requestId: TRACE }));
  });

  it("requires a versioned idempotency key for temporary restrictions", async () => {
    const restrictCase = vi.fn(async () => ({ status: "temporary_restriction", version: 2, replayed: false }));
    const handler = createAdminCaseActionHandler({ ...adminDeps(), service: { transitionCase: vi.fn(), restrictCase } });
    const response = await handler(post(`/api/v1/admin/cases/${ids.case}/actions`, {
      action: "temporary_restriction", subjectUserId: ids.target, reason: "confirmed harassment",
      durationHours: 24, expectedVersion: 1,
    }), { params: Promise.resolve({ caseId: ids.case }) });
    expect(response.status).toBe(200);
    expect(restrictCase).toHaveBeenCalledWith(expect.anything(), ids.case, expect.objectContaining({
      idempotencyKey: "moderation-action-123", expectedVersion: 1, durationHours: 24,
    }), expect.anything());
  });

  it("protects manual photo review with recent MFA and records a reason", async () => {
    const decideMedia = vi.fn(async () => ({ status: "approved", replayed: false }));
    const handler = createAdminMediaDecisionHandler({ ...adminDeps(), service: { decideMedia } });
    const response = await handler(post(`/api/v1/admin/media-reviews/${ids.job}/decision`, {
      decision: "approved", reason: "manual visual review completed",
    }), { params: Promise.resolve({ jobId: ids.job }) });
    expect(response.status).toBe(200);
    expect(decideMedia).toHaveBeenCalledWith(expect.anything(), ids.job, "approved",
      "manual visual review completed", expect.objectContaining({ requestId: TRACE }));
  });

  it("maps second-reviewer enforcement to a safe forbidden response", async () => {
    const finalizeAppeal = vi.fn(async () => { throw new Error("FORBIDDEN"); });
    const handler = createAdminAppealDecisionHandler({ ...adminDeps(), service: { finalizeAppeal } });
    const response = await handler(post(`/api/v1/admin/appeals/${ids.appeal}/decision`, {
      decision: "upheld", summary: "restriction remains proportionate",
    }), { params: Promise.resolve({ appealId: ids.appeal }) });
    expect(response.status).toBe(403);
  });

  it("assigns the independent moderator before an appeal can be finalized", async () => {
    const startAppealReview = vi.fn(async () => ({ status: "under_review" }));
    const handler = createAdminAppealReviewHandler({ ...adminDeps(), service: { startAppealReview } });
    const response = await handler(post(`/api/v1/admin/appeals/${ids.appeal}/review`, {}),
      { params: Promise.resolve({ appealId: ids.appeal }) });
    expect(response.status).toBe(200);
    expect(startAppealReview).toHaveBeenCalledWith(expect.objectContaining({ role: "moderation" }), ids.appeal);
  });

  it("lets only the affected authenticated member submit an appeal", async () => {
    const createAppeal = vi.fn(async () => ({ id: ids.appeal, status: "submitted" }));
    const handler = createMemberAppealsHandler({ getSession: vi.fn(async () => ({ user: { id: ids.target } })),
      service: { listMemberAppeals: vi.fn(), createAppeal } });
    const response = await handler(post("/api/v1/me/appeals", {
      originalCaseId: ids.case, statement: "Please review the context and duration.",
    }));
    expect(response.status).toBe(201);
    expect(createAppeal).toHaveBeenCalledWith(ids.target, ids.case, "Please review the context and duration.");
  });
});
