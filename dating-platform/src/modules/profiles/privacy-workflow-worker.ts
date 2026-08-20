type WorkflowJob = { id: string; leaseId: string; userId: string; deletionRequestId: string | null;
  exportJobId: string | null; eventType: string; attempts: number };
type WorkflowStore = {
  claim(): Promise<WorkflowJob | null>;
  complete(id: string, leaseId: string): Promise<void>;
  retry(id: string, leaseId: string, input: { errorCode: "WORKFLOW_FAILED"; availableAt: Date }): Promise<void>;
  manualReview(id: string, leaseId: string, errorCode: "WORKFLOW_FAILED"): Promise<void>;
  handleNotification(job: WorkflowJob): Promise<void>;
};

export class PrivacyWorkflowWorker {
  constructor(private readonly dependencies: { store: WorkflowStore;
    cancelRenewal(input: { userId: string; deletionRequestId: string; idempotencyKey: string }): Promise<unknown>;
    resumeRenewal?(input: { userId: string; deletionRequestId: string; idempotencyKey: string }): Promise<unknown>;
    clock?: () => Date }) {}

  async runOne() {
    const job = await this.dependencies.store.claim();
    if (!job) return false;
    try {
      if (job.eventType === "renewal_cancel_requested") {
        if (!job.deletionRequestId) throw new Error("WORKFLOW_EVENT_INVALID");
        await this.dependencies.cancelRenewal({ userId: job.userId, deletionRequestId: job.deletionRequestId,
          idempotencyKey: `privacy-deletion-${job.deletionRequestId}` });
      } else {
        if (job.eventType === "deletion_canceled") {
          if (!job.deletionRequestId || !this.dependencies.resumeRenewal) throw new Error("WORKFLOW_EVENT_INVALID");
          await this.dependencies.resumeRenewal({ userId: job.userId, deletionRequestId: job.deletionRequestId,
            idempotencyKey: `privacy-deletion-resume-${job.deletionRequestId}` });
        }
        await this.dependencies.store.handleNotification(job);
      }
      await this.dependencies.store.complete(job.id, job.leaseId);
    } catch {
      if (job.attempts >= 5) await this.dependencies.store.manualReview(job.id, job.leaseId, "WORKFLOW_FAILED");
      else {
        const now = (this.dependencies.clock ?? (() => new Date()))();
        await this.dependencies.store.retry(job.id, job.leaseId, { errorCode: "WORKFLOW_FAILED",
          availableAt: new Date(now.getTime() + Math.min(3_600_000, 1_000 * (2 ** job.attempts))) });
      }
    }
    return true;
  }
}
