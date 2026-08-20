import { describe, expect, it, vi } from "vitest";

import { PrivacyWorkflowWorker } from "@/modules/profiles/privacy-workflow-worker";

describe("PrivacyWorkflowWorker", () => {
  it("submits renewal cancellation through the shared billing intent chain and completes its lease", async () => {
    const complete = vi.fn();
    const cancelRenewal = vi.fn(async () => ({ accepted: true }));
    const worker = new PrivacyWorkflowWorker({ store: { claim: async () => ({ id: "outbox-1", leaseId: "lease-1",
      userId: "owner", deletionRequestId: "deletion-1", eventType: "renewal_cancel_requested" as const,
      exportJobId: null, attempts: 1 }), complete, retry: vi.fn(), manualReview: vi.fn(), handleNotification: vi.fn() }, cancelRenewal });

    await expect(worker.runOne()).resolves.toBe(true);
    expect(cancelRenewal).toHaveBeenCalledWith({ userId: "owner", deletionRequestId: "deletion-1",
      idempotencyKey: "privacy-deletion-deletion-1" });
    expect(complete).toHaveBeenCalledWith("outbox-1", "lease-1");
  });

  it("uses bounded retry and a redacted terminal error", async () => {
    const manualReview = vi.fn();
    const worker = new PrivacyWorkflowWorker({ store: { claim: async () => ({ id: "outbox-1", leaseId: "lease-1",
      userId: "owner", deletionRequestId: "deletion-1", eventType: "renewal_cancel_requested" as const,
      exportJobId: null, attempts: 5 }), complete: vi.fn(), retry: vi.fn(), manualReview, handleNotification: vi.fn() },
      cancelRenewal: async () => { throw new Error("stripe account secret"); } });

    await expect(worker.runOne()).resolves.toBe(true);
    expect(manualReview).toHaveBeenCalledWith("outbox-1", "lease-1", "WORKFLOW_FAILED");
  });

  it("submits an idempotent resume intent before completing a deletion-canceled event", async () => {
    const complete = vi.fn(); const resumeRenewal = vi.fn(); const handleNotification = vi.fn();
    const worker = new PrivacyWorkflowWorker({ store: { claim: async () => ({ id: "outbox-cancel", leaseId: "lease-2",
      userId: "owner", deletionRequestId: "deletion-1", exportJobId: null, eventType: "deletion_canceled",
      attempts: 1 }), complete, retry: vi.fn(), manualReview: vi.fn(), handleNotification },
    cancelRenewal: vi.fn(), resumeRenewal });
    await worker.runOne();
    expect(resumeRenewal).toHaveBeenCalledWith({ userId: "owner", deletionRequestId: "deletion-1",
      idempotencyKey: "privacy-deletion-resume-deletion-1" });
    expect(handleNotification).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith("outbox-cancel", "lease-2");
  });
});
