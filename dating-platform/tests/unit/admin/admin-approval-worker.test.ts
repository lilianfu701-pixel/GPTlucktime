import { describe, expect, it, vi } from "vitest";

import { AdminApprovalWorker } from "@/modules/admin/admin-approval-worker";

describe("AdminApprovalWorker", () => {
  it("claims a bounded lease and reaches a terminal result exactly once per claim", async () => {
    const claim = { id: "00000000-0000-4000-8000-000000000001", leaseId: "00000000-0000-4000-8000-000000000002",
      action: "sensitive_export" as const };
    const repository = {
      claim: vi.fn(async () => [claim]),
      execute: vi.fn(async () => "executed" as const),
      retry: vi.fn(),
    };
    const worker = new AdminApprovalWorker(repository, { now: () => new Date("2026-08-14T12:00:00.000Z") });
    await expect(worker.run(5)).resolves.toEqual({ claimed: 1, executed: 1, retried: 0, manualReview: 0 });
    expect(repository.claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 5, leaseMs: 30_000 }));
    expect(repository.execute).toHaveBeenCalledOnce();
  });

  it("uses stable retry/manual-review outcomes without claiming rejected or expired requests", async () => {
    const claims = [
      { id: "1", leaseId: "l1", action: "manual_refund" as const },
      { id: "2", leaseId: "l2", action: "bulk_suspension" as const },
    ];
    const repository = {
      claim: vi.fn(async () => claims),
      execute: vi.fn().mockResolvedValueOnce("retry").mockResolvedValueOnce("manual_review"),
      retry: vi.fn(),
    };
    const worker = new AdminApprovalWorker(repository, { now: () => new Date("2026-08-14T12:00:00.000Z") });
    await expect(worker.run(10)).resolves.toEqual({ claimed: 2, executed: 0, retried: 1, manualReview: 1 });
  });
});
