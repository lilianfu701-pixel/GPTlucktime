import { describe, expect, it, vi } from "vitest";

import { BillingEntitlementRefreshWorker } from "@/workers/billing-entitlement-worker";

describe("BillingEntitlementRefreshWorker", () => {
  it("invalidates cache only after the internal subscription projection commits", async () => {
    const calls: string[] = [];
    const store = {
      claim: vi.fn(async () => ({ id: "job-1", leaseId: "lease-1", userId: "user-1" })),
      applyProjection: vi.fn(async () => { calls.push("projection-committed"); }),
      complete: vi.fn(async () => { calls.push("outbox-done"); }),
      fail: vi.fn(),
    };
    const worker = new BillingEntitlementRefreshWorker({ store, invalidate: async () => { calls.push("cache-invalidated"); } });
    await expect(worker.drain(1)).resolves.toEqual({ processed: 1, failed: 0 });
    expect(calls).toEqual(["projection-committed", "cache-invalidated", "outbox-done"]);
  });

  it("requeues safely when cache invalidation fails after commit", async () => {
    const store = { claim: vi.fn(async () => ({ id: "job-1", leaseId: "lease-1", userId: "user-1" })),
      applyProjection: vi.fn(), complete: vi.fn(), fail: vi.fn() };
    const worker = new BillingEntitlementRefreshWorker({ store, invalidate: async () => { throw new Error("redis secret"); } });
    expect(await worker.drain(1)).toEqual({ processed: 0, failed: 1 });
    expect(store.applyProjection).toHaveBeenCalledOnce();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith("job-1", "lease-1", "CACHE_INVALIDATION_FAILED");
  });
});
