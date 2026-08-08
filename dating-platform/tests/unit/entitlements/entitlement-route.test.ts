// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createEntitlementsHandler } from "@/modules/entitlements/entitlement-service";

const USER_ID = "00000000-0000-4000-8000-000000000001";

describe("GET /api/v1/me/entitlements", () => {
  it("requires authentication before reading entitlements", async () => {
    const listPublic = vi.fn();
    const handler = createEntitlementsHandler({
      getSession: async () => null,
      service: { listPublic } as never,
    });
    const response = await handler(new Request("https://example.test/api/v1/me/entitlements"));
    expect(response.status).toBe(401);
    expect(listPublic).not.toHaveBeenCalled();
  });

  it("uses only the session owner and returns an allowlisted safe projection", async () => {
    const listPublic = vi.fn().mockResolvedValue([{
      key: "message.send.daily",
      kind: "quota",
      allowed: true,
      value: null,
      limit: null,
      remaining: null,
      resetAt: "2026-08-09T00:00:00.000Z",
      reason: null,
      upgradeHint: null,
      internalRuleId: "must-not-leak",
      riskScore: 99,
    }, {
      key: "internal.secret.rule",
      kind: "numeric",
      allowed: true,
      value: 99,
    }]);
    const handler = createEntitlementsHandler({
      getSession: async () => ({ user: { id: USER_ID } }),
      service: { listPublic } as never,
    });
    const response = await handler(new Request(
      "https://example.test/api/v1/me/entitlements?userId=00000000-0000-4000-8000-000000000099",
    ));
    expect(response.status).toBe(200);
    expect(listPublic).toHaveBeenCalledWith(USER_ID);
    expect(await response.json()).toEqual({ entitlements: [{
      key: "message.send.daily",
      kind: "quota",
      allowed: true,
      value: null,
      limit: null,
      remaining: null,
      resetAt: "2026-08-09T00:00:00.000Z",
      reason: null,
      upgradeHint: null,
    }] });
  });

  it("maps failures to a stable non-leaking error", async () => {
    const handler = createEntitlementsHandler({
      getSession: async () => ({ user: { id: USER_ID } }),
      service: { listPublic: vi.fn().mockRejectedValue(new Error("db password leaked")) } as never,
    });
    const response = await handler(new Request("https://example.test/api/v1/me/entitlements"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "INTERNAL_ERROR", message: "INTERNAL_ERROR" });
  });

  it("drops decisions containing non-public enum values", async () => {
    const handler = createEntitlementsHandler({
      getSession: async () => ({ user: { id: USER_ID } }),
      service: { listPublic: vi.fn().mockResolvedValue([{
        key: "message.send.daily",
        kind: "quota",
        allowed: false,
        value: null,
        limit: 1,
        remaining: 0,
        resetAt: null,
        reason: "INTERNAL_RISK_RULE_42",
        upgradeHint: "membership",
      }]) } as never,
    });
    const response = await handler(new Request("https://example.test/api/v1/me/entitlements"));
    expect(await response.json()).toEqual({ entitlements: [] });
  });
});
