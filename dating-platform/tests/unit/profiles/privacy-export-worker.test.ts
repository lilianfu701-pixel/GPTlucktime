import { describe, expect, it, vi } from "vitest";

import { PrivacyExportCleanupWorker, PrivacyExportWorker } from "@/modules/profiles/privacy-export-worker";

describe("PrivacyExportWorker", () => {
  it("writes a versioned encrypted minimal archive and marks it ready", async () => {
    const putEncrypted = vi.fn(async (artifact) => ({ versionId: "version-1", sizeBytes: artifact.body.byteLength }));
    const complete = vi.fn();
    const worker = new PrivacyExportWorker({
      store: { claim: async () => ({ id: "export-1", leaseId: "lease-1", userId: "owner", attempts: 1 }), complete,
        prepareArtifact: async (_job, artifact) => artifact,
        prepareEncryptedArtifact: async (_job, artifact) => ({ bodyBase64: artifact.bodyBase64,
          integritySha256: artifact.integritySha256 }),
        retry: vi.fn(), manualReview: vi.fn() },
      collect: async () => ({ account: { name: "Owner" }, profile: { city: "Paris" } }),
      storage: { findEncrypted: async () => null, putEncrypted, deleteVersion: vi.fn(), versionExists: vi.fn() },
      encryption: { keyId: "privacy-key-v1", key: new Uint8Array(32).fill(7) },
      clock: () => new Date("2026-08-05T00:00:00Z"),
    });
    await expect(worker.runOne()).resolves.toBe(true);
    expect(putEncrypted).toHaveBeenCalledWith(expect.objectContaining({ objectKey: "privacy-exports/owner/export-1/v1.json.enc",
      schemaVersion: 1, encryptionKeyId: "privacy-key-v1" }));
    expect(new TextDecoder().decode(putEncrypted.mock.calls[0]![0].body)).not.toContain("Owner");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ id: "export-1", objectVersion: "version-1" }));
  });

  it("finishes the same uploaded artifact after a crash before the ready transaction", async () => {
    const identity = { objectKey: "privacy-exports/owner/export-1/artifact.enc", encryptionKeyId: "privacy-key-v1",
      expiresAt: new Date("2026-08-06T00:00:00Z") };
    const jobs = [{ id: "export-1", leaseId: "lease-a", userId: "owner", attempts: 1 },
      { id: "export-1", leaseId: "lease-b", userId: "owner", attempts: 2 }];
    let uploaded: { versionId: string; contentHash: string; sizeBytes: number } | null = null;
    let prepared: { bodyBase64: string; integritySha256: string } | null = null;
    let completeCalls = 0;
    const putEncrypted = vi.fn(async (artifact) => {
      uploaded = { versionId: "version-1", contentHash: artifact.contentHash, sizeBytes: artifact.body.byteLength };
      return { versionId: "version-1", sizeBytes: artifact.body.byteLength };
    });
    const complete = vi.fn(async () => { completeCalls += 1; if (completeCalls === 1) throw new Error("database unavailable"); });
    const worker = new PrivacyExportWorker({ store: { claim: async () => jobs.shift() ?? null,
      prepareArtifact: async () => identity,
      prepareEncryptedArtifact: async (_job, artifact) => prepared ??= artifact,
      complete, retry: vi.fn(), manualReview: vi.fn() },
    collect: async () => ({ account: { name: "Owner" } }), storage: {
      findEncrypted: async () => uploaded, putEncrypted, deleteVersion: vi.fn(), versionExists: vi.fn(),
    }, encryption: { keyId: "privacy-key-v1", key: new Uint8Array(32).fill(7) },
    clock: () => new Date("2026-08-05T00:00:00Z") });

    await worker.runOne();
    await worker.runOne();
    expect(putEncrypted).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ leaseId: "lease-b",
      objectKey: identity.objectKey, objectVersion: "version-1" }));
  });

  it("deletes an expired object version before marking the export expired", async () => {
    const deleteVersion = vi.fn();
    const markExpired = vi.fn();
    const worker = new PrivacyExportCleanupWorker({
      store: { claimExpired: async () => ({ id: "export-1", leaseId: "cleanup-lease", objectKey: "privacy/owner/export-1.enc",
        objectVersion: "version-1", attempts: 1 }), markExpired, failExpiredCleanup: vi.fn() },
      storage: { deleteVersion, versionExists: async () => false },
    });

    await expect(worker.runOne()).resolves.toBe(true);
    expect(deleteVersion).toHaveBeenCalledWith({ objectKey: "privacy/owner/export-1.enc", versionId: "version-1" });
    expect(markExpired).toHaveBeenCalledWith(expect.objectContaining({ id: "export-1", leaseId: "cleanup-lease" }));
  });

  it("does not consume a second cleanup attempt when one claimed attempt fails", async () => {
    const failExpiredCleanup = vi.fn();
    const worker = new PrivacyExportCleanupWorker({
      store: { claimExpired: async () => ({ id: "export-1", leaseId: "cleanup-lease", objectKey: "privacy/export.enc",
        objectVersion: "version-1", attempts: 1 }), markExpired: vi.fn(), failExpiredCleanup },
      storage: { deleteVersion: async () => { throw new Error("storage unavailable"); }, versionExists: vi.fn() },
      clock: () => new Date("2026-08-20T00:00:00Z"),
    });

    await worker.runOne();

    expect(failExpiredCleanup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1 }),
      expect.objectContaining({ attempts: 1 }));
  });
});
