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
});
