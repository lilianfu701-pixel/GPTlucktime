import { describe, expect, it, vi } from "vitest";

import { createAdminEntitlementsHandler, createAdminUserActionsHandler } from "@/modules/admin/admin-route";
import type { AdminActor } from "@/modules/admin/admin-service";
import type { AdminRole } from "@/modules/admin/permissions";

const TRACE_ID = "00000000-0000-4000-8000-000000000099";
const NOW = new Date("2026-08-14T12:00:00.000Z");
const session = (role: AdminRole = "safety"): AdminActor => ({
  userId: "00000000-0000-4000-8000-000000000001",
  adminSessionId: "00000000-0000-4000-8000-000000000099",
  role,
  mfaVerifiedAt: new Date(NOW.getTime() - 60_000),
});
const request = (url: string, body: unknown, headers: Record<string, string> = {}) => new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://app.example", "idempotency-key": "admin-action-1234", ...headers },
  body: JSON.stringify(body),
});
const base = () => ({
  getSession: vi.fn(async () => session()),
  limiter: { consume: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) },
  isTrustedOrigin: vi.fn(() => true),
  resolveClientIp: vi.fn(() => "203.0.113.8"),
  now: () => NOW,
  createTraceId: () => TRACE_ID,
});

describe("admin route handlers", () => {
  it("rejects methods before touching session or any dependency", async () => {
    const deps = base();
    const handler = createAdminUserActionsHandler({ ...deps, service: { applyUserStatusAction: vi.fn() } });
    const response = await handler(new Request("https://app.example/api/v1/admin/users/u/actions"),
      { params: Promise.resolve({ userId: "u" }) });
    expect(response.status).toBe(405);
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it("uses only the independent server admin session and checks auth before body", async () => {
    const deps = base();
    deps.getSession.mockResolvedValueOnce(null as never);
    const service = { applyUserStatusAction: vi.fn() };
    const handler = createAdminUserActionsHandler({ ...deps, service });
    const response = await handler(new Request("https://app.example/api/v1/admin/users/u/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "not-json",
    }), { params: Promise.resolve({ userId: "u" }) });
    expect(response.status).toBe(401);
    expect(service.applyUserStatusAction).not.toHaveBeenCalled();
  });

  it("fails closed with a safe 503 when the independent admin session store is unavailable", async () => {
    const deps = base();
    deps.getSession.mockRejectedValueOnce(new Error("redis socket details"));
    const applyUserStatusAction = vi.fn();
    const handler = createAdminUserActionsHandler({ ...deps, service: { applyUserStatusAction } });
    const response = await handler(new Request("https://app.example/api/v1/admin/users/u/actions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "not-json",
    }), { params: Promise.resolve({ userId: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(expect.objectContaining({ code: "SERVICE_UNAVAILABLE", traceId: TRACE_ID }));
    expect(applyUserStatusAction).not.toHaveBeenCalled();
    expect(deps.limiter.consume).not.toHaveBeenCalled();
  });

  it("rejects forged actor or role fields and requires trusted origin and fail-closed limiter", async () => {
    const deps = base();
    const service = { applyUserStatusAction: vi.fn() };
    const handler = createAdminUserActionsHandler({ ...deps, service });
    const forged = await handler(request("https://app.example/api/v1/admin/users/u/actions", {
      action: "suspend", caseId: "00000000-0000-4000-8000-000000000010", reason: "confirmed abuse",
      expectedVersion: 1, durationHours: 24, actorUserId: "attacker", role: "super_admin",
    }), { params: Promise.resolve({ userId: "00000000-0000-4000-8000-000000000002" }) });
    expect(forged.status).toBe(400);
    expect(service.applyUserStatusAction).not.toHaveBeenCalled();

    deps.isTrustedOrigin.mockReturnValueOnce(false);
    const denied = await handler(request("https://app.example/api/v1/admin/users/u/actions", {
      action: "suspend", caseId: "00000000-0000-4000-8000-000000000010", reason: "confirmed abuse",
      expectedVersion: 1, durationHours: 24,
    }), { params: Promise.resolve({ userId: "00000000-0000-4000-8000-000000000002" }) });
    expect(denied.status).toBe(403);

    deps.limiter.consume.mockRejectedValueOnce(new Error("redis details"));
    const outage = await handler(request("https://app.example/api/v1/admin/users/u/actions", {
      action: "suspend", caseId: "00000000-0000-4000-8000-000000000010", reason: "confirmed abuse",
      expectedVersion: 1, durationHours: 24,
    }), { params: Promise.resolve({ userId: "00000000-0000-4000-8000-000000000002" }) });
    expect(outage.status).toBe(503);
    expect(JSON.stringify(await outage.json())).not.toContain("redis");
  });

  it("passes server-authoritative actor, target, idempotency and version to governance", async () => {
    const deps = base();
    const applyUserStatusAction = vi.fn(async () => ({ status: "suspended", version: 2, replayed: false }));
    const handler = createAdminUserActionsHandler({ ...deps, service: { applyUserStatusAction } });
    const response = await handler(request("https://app.example/api/v1/admin/users/u/actions", {
      action: "suspend", caseId: "00000000-0000-4000-8000-000000000010", reason: "confirmed abuse",
      expectedVersion: 1, durationHours: 24,
    }), { params: Promise.resolve({ userId: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(200);
    expect(applyUserStatusAction).toHaveBeenCalledWith(session(), "00000000-0000-4000-8000-000000000002",
      expect.objectContaining({ idempotencyKey: "admin-action-1234", expectedVersion: 1 }),
      { requestId: TRACE_ID, ipAddress: "203.0.113.8" });
  });

  it("rejects PII-bearing reasons before governance or audit persistence", async () => {
    const deps = base();
    const applyUserStatusAction = vi.fn();
    const handler = createAdminUserActionsHandler({ ...deps, service: { applyUserStatusAction } });
    const response = await handler(request("https://app.example/api/v1/admin/users/u/actions", {
      action: "suspend", caseId: "00000000-0000-4000-8000-000000000010",
      reason: "contact reviewer@example.com", expectedVersion: 1, durationHours: 24,
    }), { params: Promise.resolve({ userId: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(400);
    expect(applyUserStatusAction).not.toHaveBeenCalled();
  });

  it("protects entitlement configuration with its own permission and strict versioned input", async () => {
    const deps = base();
    deps.getSession.mockResolvedValueOnce(session("moderation") as never);
    const updateEntitlementConfiguration = vi.fn();
    const handler = createAdminEntitlementsHandler({ ...deps, service: { updateEntitlementConfiguration } });
    const body = { entitlementKey: "message.send.daily", scope: "free_default", expectedVersion: 3,
      reason: "quota adjustment", grant: { kind: "quota", enabled: true, booleanValue: null,
        quotaLimit: 20, numericValue: null, upgradeHint: "plans.plus" } };
    expect((await handler(request("https://app.example/api/v1/admin/entitlements", body))).status).toBe(403);
    expect(updateEntitlementConfiguration).not.toHaveBeenCalled();
  });

  it("accepts only the Task7 null-value shape for global_flag", async () => {
    const deps = base();
    deps.getSession.mockResolvedValue(session("super_admin"));
    const updateEntitlementConfiguration = vi.fn(async () => ({ version: 2 }));
    const handler = createAdminEntitlementsHandler({ ...deps, service: { updateEntitlementConfiguration } });
    const valid = { entitlementKey: "message.send.daily", scope: "global_flag", expectedVersion: 1,
      reason: "disable during safety response", grant: { kind: "quota", enabled: false,
        booleanValue: null, quotaLimit: null, numericValue: null, upgradeHint: null } };
    expect((await handler(request("https://app.example/api/v1/admin/entitlements", valid))).status).toBe(201);
    const invalid = { ...valid, grant: { ...valid.grant, quotaLimit: 10 } };
    expect((await handler(request("https://app.example/api/v1/admin/entitlements", invalid))).status).toBe(400);
    expect(updateEntitlementConfiguration).toHaveBeenCalledTimes(1);
  });
});
