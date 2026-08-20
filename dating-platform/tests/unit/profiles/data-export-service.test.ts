import { describe, expect, it, vi } from "vitest";

import { DataExportService } from "@/modules/profiles/data-export-service";

describe("DataExportService", () => {
  it("creates an owner-bound asynchronous export without returning an object key", async () => {
    const enqueueNotification = vi.fn();
    const service = new DataExportService({
      createOrGet: async (input) => ({ jobId: "export-1", status: "pending" as const, replayed: false, ownerId: input.userId }),
      enqueueNotification,
    });
    await expect(service.request({ userId: "owner", idempotencyKey: "export-request-0001",
      now: new Date("2026-08-05T00:00:00Z") })).resolves.toEqual({ jobId: "export-1", status: "pending", replayed: false });
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it("rejects a download issued for a different owner", async () => {
    const service = new DataExportService({ createOrGet: async () => { throw new Error("unused"); },
      enqueueNotification: async () => {},
      claimDownload: async () => ({ jobId: "export-1", leaseId: crypto.randomUUID(), ownerId: "other",
        tokenHash: "a".repeat(64), objectKey: "privacy/export.enc", objectVersion: "v1",
        integritySha256: "b".repeat(64), encryptionKeyId: "privacy-export-v1",
        expiresAt: new Date(Date.now() + 60_000) }), readDownload: async () => new Uint8Array(),
      completeDownload: async () => true, releaseDownload: async () => true });
    await expect(service.download({ userId: "owner", jobId: "export-1", token: "d".repeat(43), now: new Date() }))
      .rejects.toThrow("EXPORT_NOT_AVAILABLE");
  });

  it("releases a failed read, completes a retry, and rejects the token after success", async () => {
    const claim = { jobId: "11111111-1111-4111-8111-111111111111", leaseId: crypto.randomUUID(), ownerId: "owner",
      tokenHash: "a".repeat(64), objectKey: "privacy/export.enc", objectVersion: "version-1",
      integritySha256: "b".repeat(64), encryptionKeyId: "privacy-export-v1",
      expiresAt: new Date("2026-08-20T18:15:00Z") };
    let readAttempt = 0; let consumed = false;
    const releaseDownload = vi.fn(async () => true);
    const service = new DataExportService({ createOrGet: async () => { throw new Error("unused"); },
      enqueueNotification: async () => {},
      claimDownload: async () => consumed ? null : claim,
      readDownload: async () => { readAttempt += 1; if (readAttempt === 1) throw new Error("S3_SECRET_TIMEOUT");
        return new TextEncoder().encode("export"); },
      completeDownload: async () => { consumed = true; return true; }, releaseDownload });
    const input = { userId: "owner", jobId: claim.jobId, token: "d".repeat(43),
      now: new Date("2026-08-20T18:00:00Z") };

    await expect(service.download(input)).rejects.toThrow("EXPORT_DOWNLOAD_FAILED");
    expect(releaseDownload).toHaveBeenCalledWith(claim);
    await expect(service.download(input)).resolves.toEqual({ body: new TextEncoder().encode("export"),
      filename: "heartline-data-export.json" });
    await expect(service.download(input)).rejects.toThrow("EXPORT_NOT_AVAILABLE");
  });

  it("does not return decrypted bytes when completion fails and leaves the lease to expire", async () => {
    const claim = { jobId: "11111111-1111-4111-8111-111111111111", leaseId: crypto.randomUUID(), ownerId: "owner",
      tokenHash: "a".repeat(64), objectKey: "privacy/export.enc", objectVersion: "version-1",
      integritySha256: "b".repeat(64), encryptionKeyId: "privacy-export-v1",
      expiresAt: new Date("2026-08-20T18:15:00Z") };
    const releaseDownload = vi.fn(async () => true);
    const service = new DataExportService({ createOrGet: async () => { throw new Error("unused"); },
      enqueueNotification: async () => {}, claimDownload: async () => claim,
      readDownload: async () => new TextEncoder().encode("must-not-return"),
      completeDownload: async () => { throw new Error("DATABASE_UNAVAILABLE"); }, releaseDownload });

    await expect(service.download({ userId: "owner", jobId: claim.jobId, token: "d".repeat(43),
      now: new Date("2026-08-20T18:00:00Z") })).rejects.toThrow("EXPORT_DOWNLOAD_FAILED");
    expect(releaseDownload).not.toHaveBeenCalled();
  });
});
