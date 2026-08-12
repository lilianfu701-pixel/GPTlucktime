// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createMediaWorkerRoute } from "@/modules/profiles/media-worker-route";

const secret = "media-worker-secret-that-is-at-least-32-characters";

describe("internal media worker route", () => {
  it.each([
    undefined,
    "Bearer wrong-secret-that-is-at-least-32-characters",
    `bearer ${secret}`,
    `Bearer  ${secret}`,
  ])("rejects an inexact authorization header without running work: %s", async (authorization) => {
    const run = vi.fn();
    const POST = createMediaWorkerRoute({ secret, run });
    const headers = authorization ? { authorization } : undefined;

    const response = await POST(new Request("https://app.test/api/internal/workers/media-review", {
      method: "POST",
      headers,
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "UNAUTHORIZED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns observable review and cleanup counts", async () => {
    const run = vi.fn().mockResolvedValue({
      reviewed: 3, deleted: 2, uploadArtifactsDeleted: 4, legacyPreserved: 5,
    });
    const POST = createMediaWorkerRoute({ secret, run });

    const response = await POST(new Request("https://app.test/api/internal/workers/media-review", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reviewed: 3,
      deleted: 2,
      uploadArtifactsDeleted: 4,
      legacyPreserved: 5,
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails closed without leaking worker errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("storage host and credential detail"));
    const POST = createMediaWorkerRoute({ secret, run });

    const response = await POST(new Request("https://app.test/api/internal/workers/media-review", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "MEDIA_WORKER_FAILED" });
  });
});
