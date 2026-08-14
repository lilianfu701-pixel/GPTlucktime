import { describe, expect, it, vi } from "vitest";

import { createBillingWorkerRoute } from "@/modules/billing/billing-worker-route";

describe("billing worker route", () => {
  it("uses timing-safe bearer authentication and never runs without it", async () => {
    const run = vi.fn(async () => ({ entitlement: { processed: 1, failed: 0 }, reconciliation: { runs: 1 } }));
    const handler = createBillingWorkerRoute({ secret: "billing-worker-secret-at-least-32-characters", run });
    for (const authorization of [null, "Bearer wrong", "Basic billing-worker-secret-at-least-32-characters"]) {
      const headers = authorization ? { authorization } : undefined;
      const response = await handler(new Request("https://app.example/api/internal/workers/billing", { method: "POST", headers }));
      expect(response.status).toBe(401);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("returns bounded counts and hides worker errors", async () => {
    const secret = "billing-worker-secret-at-least-32-characters";
    const ok = createBillingWorkerRoute({ secret, run: async () => ({ entitlement: { processed: 1, failed: 0 }, reconciliation: { runs: 1 } }) });
    expect((await ok(new Request("https://app.example/api/internal/workers/billing", {
      method: "POST", headers: { authorization: `Bearer ${secret}` },
    }))).status).toBe(200);
    const failed = createBillingWorkerRoute({ secret, run: async () => { throw new Error("stripe secret"); } });
    const response = await failed(new Request("https://app.example/api/internal/workers/billing", {
      method: "POST", headers: { authorization: `Bearer ${secret}` },
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "BILLING_WORKER_FAILED" });
  });
});
