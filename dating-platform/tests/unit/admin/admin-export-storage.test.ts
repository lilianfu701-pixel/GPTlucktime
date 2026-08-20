import { expect, it, vi } from "vitest";

import { S3AdminExportStorage } from "@/modules/admin/admin-export-storage";

it("stores admin exports with server-side encryption, checksum and a required immutable version", async () => {
  let stored = false;
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (command.constructor.name === "HeadObjectCommand") {
      if (!stored) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
      return { VersionId: "version-1", ContentLength: 35, ServerSideEncryption: "AES256",
        ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64"),
        Metadata: { contenthash: "a".repeat(64), schema: "admin-sensitive-export", version: "1",
          expires: "2026-08-15T12:00:00.000Z" } };
    }
    stored = true;
    return { VersionId: "version-1", command: command.input };
  });
  const storage = new S3AdminExportStorage({ endpoint: "https://storage.example", region: "us-test-1",
    bucket: "private-admin-exports", accessKeyId: "access", secretAccessKey: "secret", client: { send } as never });
  const body = new TextEncoder().encode('{"schema":"admin-sensitive-export"}');
  await expect(storage.putEncrypted({ objectKey: "admin-exports/request/hash.v1.json", body,
    contentHash: "a".repeat(64), schemaVersion: 1, expiresAt: new Date("2026-08-15T12:00:00.000Z") }))
    .resolves.toEqual({ versionId: "version-1", sizeBytes: body.byteLength });
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[1]![0].input).toEqual(expect.objectContaining({
    Bucket: "private-admin-exports", Key: "admin-exports/request/hash.v1.json",
    ServerSideEncryption: "AES256", ChecksumSHA256: expect.any(String), ContentType: "application/json",
  }));
});

it("rejects a new object when the post-PUT version HEAD lacks required encryption metadata", async () => {
  let stored = false;
  const send = vi.fn(async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === "HeadObjectCommand") {
      if (!stored) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
      return { VersionId: "version-unsafe", ContentLength: 32, Metadata: {} };
    }
    stored = true;
    return { VersionId: "version-unsafe" };
  });
  const storage = new S3AdminExportStorage({ endpoint: "https://storage.example", region: "us-test-1",
    bucket: "private-admin-exports", accessKeyId: "access", secretAccessKey: "secret", client: { send } as never });
  await expect(storage.putEncrypted({ objectKey: "admin-exports/request/hash.v1.json", body: new Uint8Array(32),
    contentHash: "c".repeat(64), schemaVersion: 1,
    expiresAt: new Date("2026-08-15T12:00:00.000Z") })).rejects.toThrow("ADMIN_EXPORT_STORAGE_CONFLICT");
  expect(send).toHaveBeenCalledTimes(3);
});

it("reconciles a previously stored identical artifact without issuing a second put", async () => {
  let stored = false;
  let putCalls = 0;
  const send = vi.fn(async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === "HeadObjectCommand") {
      if (!stored) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
      return { VersionId: "version-stable", ContentLength: 32, ServerSideEncryption: "AES256",
        ChecksumSHA256: Buffer.from("b".repeat(64), "hex").toString("base64"),
        Metadata: { contenthash: "b".repeat(64), schema: "admin-sensitive-export", version: "1",
          expires: "2026-08-15T12:00:00.000Z" } };
    }
    stored = true; putCalls += 1; return { VersionId: "version-stable" };
  });
  const storage = new S3AdminExportStorage({ endpoint: "https://storage.example", region: "us-test-1",
    bucket: "private-admin-exports", accessKeyId: "access", secretAccessKey: "secret", client: { send } as never });
  const body = new Uint8Array(32);
  const artifact = { objectKey: "admin-exports/request/hash.v1.json", body, contentHash: "b".repeat(64),
    schemaVersion: 1, expiresAt: new Date("2026-08-15T12:00:00.000Z") };
  await storage.putEncrypted(artifact);
  await expect(storage.putEncrypted(artifact)).resolves.toEqual({ versionId: "version-stable", sizeBytes: 32 });
  expect(putCalls).toBe(1);
});

it("verifies a ready artifact without recreating a missing object or accepting another version", async () => {
  const send = vi.fn(async () => {
    throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
  });
  const storage = new S3AdminExportStorage({ endpoint: "https://storage.example", region: "us-test-1",
    bucket: "private-admin-exports", accessKeyId: "access", secretAccessKey: "secret", client: { send } as never });
  const body = new Uint8Array(32);
  await expect(storage.verifyEncrypted({ objectKey: "admin-exports/request/hash.v1.json", body,
    contentHash: "b".repeat(64), schemaVersion: 1, expiresAt: new Date("2026-08-15T12:00:00.000Z") },
  "version-stable")).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});

it("deletes only the requested immutable version and confirms it no longer exists", async () => {
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (command.constructor.name === "DeleteObjectCommand") return { VersionId: "version-stable" };
    throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
  });
  const storage = new S3AdminExportStorage({ endpoint: "https://storage.example", region: "us-test-1",
    bucket: "private-admin-exports", accessKeyId: "access", secretAccessKey: "secret", client: { send } as never });
  await expect(storage.deleteVersion({ objectKey: "admin-exports/request/hash.v1.json",
    versionId: "version-stable" })).resolves.toBeUndefined();
  expect(send.mock.calls.map(([command]) => ({ name: command.constructor.name, input: command.input })))
    .toEqual([
      { name: "DeleteObjectCommand", input: { Bucket: "private-admin-exports",
        Key: "admin-exports/request/hash.v1.json", VersionId: "version-stable" } },
      { name: "HeadObjectCommand", input: { Bucket: "private-admin-exports",
        Key: "admin-exports/request/hash.v1.json", VersionId: "version-stable" } },
    ]);
});
