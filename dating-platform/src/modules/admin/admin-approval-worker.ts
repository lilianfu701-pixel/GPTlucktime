import type { SensitiveAdminAction } from "./admin-service";

export type ClaimedAdminApproval = { id: string; leaseId: string; action: SensitiveAdminAction };
export interface AdminApprovalExecutionRepository {
  claim(input: { limit: number; now: Date; leaseMs: number }): Promise<ClaimedAdminApproval[]>;
  execute(claim: ClaimedAdminApproval, now: Date): Promise<"executed" | "retry" | "manual_review">;
}

export class AdminApprovalWorker {
  private readonly now: () => Date;
  constructor(private readonly repository: AdminApprovalExecutionRepository, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async run(rawLimit = 10) {
    const limit = Math.max(1, Math.min(25, Math.floor(rawLimit)));
    const claims = await this.repository.claim({ limit, now: this.now(), leaseMs: 30_000 });
    const totals = { claimed: claims.length, executed: 0, retried: 0, manualReview: 0 };
    for (const claim of claims) {
      const outcome = await this.repository.execute(claim, this.now());
      if (outcome === "executed") totals.executed += 1;
      else if (outcome === "retry") totals.retried += 1;
      else totals.manualReview += 1;
    }
    return totals;
  }
}
