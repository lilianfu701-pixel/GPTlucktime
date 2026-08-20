const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

type ExportDependencies = {
  createOrGet(input: { userId: string; idempotencyKey: string; requestedAt: Date }): Promise<{
    jobId: string; ownerId: string; status: "pending" | "processing" | "ready" | "failed"; replayed: boolean;
  }>;
  enqueueNotification(input: { userId: string; jobId: string; templateKey: string }): Promise<void>;
  claimDownload?(input: { userId: string; jobId: string; token: string; now: Date }): Promise<DownloadClaim | null>;
  readDownload?(claim: DownloadClaim): Promise<Uint8Array>;
  completeDownload?(claim: DownloadClaim): Promise<boolean>;
  releaseDownload?(claim: DownloadClaim): Promise<boolean>;
};

export type DownloadClaim = { jobId: string; leaseId: string; ownerId: string; tokenHash: string;
  objectKey: string; objectVersion: string; integritySha256: string; encryptionKeyId: string; expiresAt: Date };

export class DataExportService {
  constructor(private readonly dependencies: ExportDependencies) {}

  async request(input: { userId: string; idempotencyKey: string; now: Date }) {
    if (!idempotencyPattern.test(input.idempotencyKey)) throw new Error("INVALID_EXPORT_REQUEST");
    const job = await this.dependencies.createOrGet({ userId: input.userId,
      idempotencyKey: input.idempotencyKey, requestedAt: input.now });
    if (job.ownerId !== input.userId) throw new Error("EXPORT_NOT_AVAILABLE");
    return { jobId: job.jobId, status: job.status, replayed: job.replayed };
  }

  async download(input: { userId: string; jobId: string; token: string; now: Date }) {
    const { claimDownload, readDownload, completeDownload, releaseDownload } = this.dependencies;
    if (!claimDownload || !readDownload || !completeDownload || !releaseDownload) {
      throw new Error("EXPORT_NOT_AVAILABLE");
    }
    const claim = await claimDownload(input);
    if (!claim || claim.ownerId !== input.userId || claim.expiresAt <= input.now) throw new Error("EXPORT_NOT_AVAILABLE");
    let body: Uint8Array;
    try { body = await readDownload(claim); } catch {
      try { await releaseDownload(claim); } catch { /* expiry remains the recovery path */ }
      throw new Error("EXPORT_DOWNLOAD_FAILED");
    }
    let completed: boolean;
    try { completed = await completeDownload(claim); } catch { throw new Error("EXPORT_DOWNLOAD_FAILED"); }
    if (!completed) throw new Error("EXPORT_NOT_AVAILABLE");
    return { body, filename: "heartline-data-export.json" };
  }
}
