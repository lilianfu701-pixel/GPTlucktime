import { createHash } from "node:crypto";

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { S3PrivacyExportStorage } from "@/modules/profiles/privacy-export-storage";

describe("S3PrivacyExportStorage", () => {
  it("reuses an intact version when an earlier upload completed before the database commit", async () => {
    const body = new TextEncoder().encode("encrypted archive");
    const contentHash = createHash("sha256").update(body).digest("hex");
    const checksum = Buffer.from(contentHash, "hex").toString("base64");
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { VersionId: "version-existing", ContentLength: body.byteLength,
        ChecksumSHA256: checksum, ServerSideEncryption: "AES256",
        Metadata: { schema: "privacy-export", version: "1", contenthash: contentHash,
          encryptionkeyid: "privacy-key-v1", expires: "2026-08-06T00:00:00.000Z" } };
      if (command instanceof PutObjectCommand) throw new Error("unexpected duplicate upload");
      throw new Error("unexpected command");
    });
    const storage = new S3PrivacyExportStorage({ endpoint: "https://storage.example", region: "auto",
      bucket: "privacy", accessKeyId: "access", secretAccessKey: "secret", client: { send } as unknown as S3Client });

    await expect(storage.putEncrypted({ objectKey: "privacy-exports/owner/job/v1.json.enc", body, contentHash,
      schemaVersion: 1, encryptionKeyId: "privacy-key-v1", expiresAt: new Date("2026-08-06T00:00:00Z") }))
      .resolves.toEqual({ versionId: "version-existing", sizeBytes: body.byteLength });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, Buffer.from("b".repeat(64), "hex").toString("base64")])(
    "rejects replay HEAD responses with a missing or mismatched object checksum", async (ChecksumSHA256) => {
      const contentHash = "a".repeat(64);
      const send = vi.fn(async () => ({ VersionId: "bad-version", ContentLength: 42, ChecksumSHA256,
        ServerSideEncryption: "AES256", Metadata: { schema: "privacy-export", version: "1",
          contenthash: contentHash, encryptionkeyid: "privacy-key-v1", expires: "2026-08-06T00:00:00.000Z" } }));
      const storage = new S3PrivacyExportStorage({ endpoint: "https://storage.example", region: "auto",
        bucket: "privacy", accessKeyId: "access", secretAccessKey: "secret",
        client: { send } as unknown as S3Client });
      await expect(storage.findEncrypted({ objectKey: "privacy-exports/owner/job/v1.json.enc",
        encryptionKeyId: "privacy-key-v1", contentHash, expiresAt: new Date("2026-08-06T00:00:00Z") }))
        .rejects.toThrow("PRIVACY_EXPORT_STORAGE_CONFLICT");
    },
  );

  it("stops reading as soon as the streamed body exceeds the bound despite a false ContentLength", async () => {
    const contentHash = "a".repeat(64);
    const checksum = Buffer.from(contentHash, "hex").toString("base64");
    const transformToByteArray = vi.fn(async () => new Uint8Array(12 * 1024 * 1024));
    const body = {
      transformToByteArray,
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(6 * 1024 * 1024);
        yield new Uint8Array(6 * 1024 * 1024);
        throw new Error("reader did not stop at the size bound");
      },
    };
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) return { VersionId: "version-1", ContentLength: 1,
        ChecksumSHA256: checksum, ServerSideEncryption: "AES256", Body: body };
      throw new Error("unexpected command");
    });
    const storage = new S3PrivacyExportStorage({ endpoint: "https://storage.example", region: "auto",
      bucket: "privacy", accessKeyId: "access", secretAccessKey: "secret",
      client: { send } as unknown as S3Client });

    await expect(storage.readEncrypted({ objectKey: "privacy/job.enc", objectVersion: "version-1",
      integritySha256: contentHash })).rejects.toThrow("PRIVACY_EXPORT_STORAGE_CONFLICT");
    expect(transformToByteArray).not.toHaveBeenCalled();
  });
});
