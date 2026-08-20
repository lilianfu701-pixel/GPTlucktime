const COOLING_OFF_DAYS = 30;

export function deletionSchedule(requestedAt: Date, legalHold: boolean) {
  const executeAt = new Date(requestedAt);
  executeAt.setUTCDate(executeAt.getUTCDate() + COOLING_OFF_DAYS);
  return { executeAt, preserveHeldRecords: legalHold };
}

type BeginResult = { requestId: string; executeAt: Date; preserveHeldRecords: boolean;
  cancellationToken: string | null; replayed: boolean };
type DeletionDependencies = {
  begin(input: { userId: string; idempotencyKey: string; requestedAt: Date; executeAt: Date;
    preserveHeldRecords: boolean }): Promise<BeginResult>;
  revokeSessions(userId: string): Promise<void>;
  hideProfile(userId: string): Promise<void>;
  enqueueRenewalCancellation(input: { userId: string; requestId: string }): Promise<void>;
  enqueueNotification(input: { userId: string; requestId: string; templateKey: string }): Promise<void>;
  authenticateCancellation?(input: { token: string; now: Date }): Promise<{ userId: string } | null>;
  cancel?(input: { token: string; idempotencyKey: string }): Promise<{ canceled: boolean; idempotencyKey: string }>;
  hasLegalHold?(userId: string): Promise<boolean>;
};

const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export class DeletionService {
  constructor(private readonly dependencies: DeletionDependencies) {}

  async request(input: { userId: string; idempotencyKey: string; now: Date }) {
    if (!idempotencyPattern.test(input.idempotencyKey)) throw new Error("INVALID_DELETION_REQUEST");
    const legalHold = await this.dependencies.hasLegalHold?.(input.userId) ?? false;
    const schedule = deletionSchedule(input.now, legalHold);
    const request = await this.dependencies.begin({ userId: input.userId, idempotencyKey: input.idempotencyKey,
      requestedAt: input.now, ...schedule });
    if (!request.replayed) {
      await this.dependencies.revokeSessions(input.userId);
      await this.dependencies.hideProfile(input.userId);
      await this.dependencies.enqueueRenewalCancellation({ userId: input.userId, requestId: request.requestId });
    }
    return { requestId: request.requestId, status: "cooling_off" as const,
      executeAt: request.executeAt, preserveHeldRecords: request.preserveHeldRecords,
      replayed: request.replayed };
  }

  authenticateCancellation(input: { token: string; now: Date }) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.token) || !this.dependencies.authenticateCancellation) {
      return Promise.resolve(null);
    }
    return this.dependencies.authenticateCancellation(input);
  }

  async cancel(input: { token: string; idempotencyKey: string }) {
    if (!idempotencyPattern.test(input.idempotencyKey) || !this.dependencies.cancel) {
      throw new Error("INVALID_DELETION_REQUEST");
    }
    return this.dependencies.cancel(input);
  }
}

export type DeletionJob = { id: string; leaseId: string; userId: string; preserveHeldRecords: boolean; attempts: number };
type DeletionWorkerStore = {
  claim(): Promise<DeletionJob | null>;
  retainRestricted(job: DeletionJob): Promise<void>;
  anonymizeEligible(job: DeletionJob): Promise<void>;
  complete(job: DeletionJob): Promise<void>;
  retry(job: DeletionJob, input: { errorCode: "DELETION_FAILED"; availableAt: Date }): Promise<void>;
  manualReview(job: DeletionJob, errorCode: "DELETION_FAILED"): Promise<void>;
};

export class DeletionWorker {
  constructor(private readonly store: DeletionWorkerStore, private readonly clock: () => Date = () => new Date()) {}

  async runOne() {
    const job = await this.store.claim();
    if (!job) return false;
    try {
      await this.store.retainRestricted(job);
      await this.store.anonymizeEligible(job);
      await this.store.complete(job);
    } catch {
      if (job.attempts >= 5) await this.store.manualReview(job, "DELETION_FAILED");
      else await this.store.retry(job, { errorCode: "DELETION_FAILED",
        availableAt: new Date(this.clock().getTime() + Math.min(3_600_000, 1_000 * (2 ** job.attempts))) });
    }
    return true;
  }
}
