// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createProfileActionHandler,
  createSocialListHandler,
} from "@/modules/social/social-service";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PROFILE_ID = "00000000-0000-4000-8000-000000000002";

describe("social service handlers", () => {
  it("requires authentication and validates UUIDs and idempotency headers before repository access", async () => {
    const like = vi.fn();
    const unauthorized = createProfileActionHandler({
      action: "like",
      getSession: async () => null,
      repository: { like } as never,
    });
    expect((await unauthorized(new Request(`https://example.test/api/v1/profiles/${PROFILE_ID}/like`, {
      method: "POST", headers: { "Idempotency-Key": "valid-social-key" },
    }), { params: Promise.resolve({ profileId: PROFILE_ID }) })).status).toBe(401);

    const handler = createProfileActionHandler({
      action: "like",
      getSession: async () => ({ user: { id: USER_ID } }),
      repository: { like } as never,
    });
    expect((await handler(new Request("https://example.test/api/v1/profiles/not-a-uuid/like", {
      method: "POST", headers: { "Idempotency-Key": "valid-social-key" },
    }), { params: Promise.resolve({ profileId: "not-a-uuid" }) })).status).toBe(400);
    expect((await handler(new Request(`https://example.test/api/v1/profiles/${PROFILE_ID}/like`, {
      method: "POST", headers: { "Idempotency-Key": "bad key with spaces" },
    }), { params: Promise.resolve({ profileId: PROFILE_ID }) })).status).toBe(400);
    expect(like).not.toHaveBeenCalled();
  });

  it("returns stable non-leaking errors and maps idempotency conflicts", async () => {
    const handler = createProfileActionHandler({
      action: "favorite",
      getSession: async () => ({ user: { id: USER_ID } }),
      repository: {
        favorite: vi.fn().mockRejectedValue(new Error("IDEMPOTENCY_CONFLICT")),
      } as never,
    });
    const response = await handler(new Request(`https://example.test/api/v1/profiles/${PROFILE_ID}/favorite`, {
      method: "POST", headers: { "Idempotency-Key": "valid-social-key" },
    }), { params: Promise.resolve({ profileId: PROFILE_ID }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: "IDEMPOTENCY_CONFLICT" });
  });

  it("bounds list pagination to fifty and rejects malformed cursors", async () => {
    const listMatches = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const handler = createSocialListHandler({
      kind: "matches",
      getSession: async () => ({ user: { id: USER_ID } }),
      repository: { listMatches } as never,
    });
    expect((await handler(new Request("https://example.test/api/v1/matches?pageSize=51"))).status).toBe(400);
    expect((await handler(new Request("https://example.test/api/v1/matches?cursor=not-opaque"))).status).toBe(400);
    expect(listMatches).not.toHaveBeenCalled();
  });

  it("requires likes.received.view only for received likes and stops before repository access", async () => {
    const listLikes = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const authorizeEntitlement = vi.fn().mockResolvedValue(false);
    const handler = createSocialListHandler({
      kind: "likes",
      getSession: async () => ({ user: { id: USER_ID } }),
      authorizeEntitlement,
      repository: { listLikes } as never,
    });

    const denied = await handler(new Request("https://example.test/api/v1/me/likes?direction=received"));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: "ENTITLEMENT_DENIED", message: "ENTITLEMENT_DENIED" });
    expect(authorizeEntitlement).toHaveBeenCalledWith(USER_ID, "likes.received.view");
    expect(listLikes).not.toHaveBeenCalled();

    const sent = await handler(new Request("https://example.test/api/v1/me/likes?direction=sent"));
    expect(sent.status).toBe(200);
    expect(authorizeEntitlement).toHaveBeenCalledTimes(1);
    expect(listLikes).toHaveBeenCalledOnce();
  });

  it("requires profile.visitors.view after authentication and before repository access", async () => {
    const listVisitors = vi.fn();
    const authorizeEntitlement = vi.fn().mockResolvedValue(false);
    const handler = createSocialListHandler({
      kind: "visitors",
      getSession: async () => ({ user: { id: USER_ID } }),
      authorizeEntitlement,
      repository: { listVisitors } as never,
    });
    const response = await handler(new Request("https://example.test/api/v1/me/visitors"));
    expect(response.status).toBe(403);
    expect(authorizeEntitlement).toHaveBeenCalledWith(USER_ID, "profile.visitors.view");
    expect(listVisitors).not.toHaveBeenCalled();
  });

  it("does not evaluate list entitlements for an unauthenticated request", async () => {
    const authorizeEntitlement = vi.fn();
    const handler = createSocialListHandler({
      kind: "visitors",
      getSession: async () => null,
      authorizeEntitlement,
      repository: { listVisitors: vi.fn() } as never,
    });
    expect((await handler(new Request("https://example.test/api/v1/me/visitors"))).status).toBe(401);
    expect(authorizeEntitlement).not.toHaveBeenCalled();
  });
});
