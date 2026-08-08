// @vitest-environment node

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  createPhotoCompleteHandler,
  createPhotoListHandler,
  createPhotoUploadHandler,
  S3StorageAdapter,
  collectBoundedBody,
  type ObjectMetadata,
  type PhotoMediaStore,
  type StorageAdapter,
} from "@/modules/profiles/media-service";

const userId = "83e8d1e5-e2c1-4190-828f-30751db022a3";

class FakeStorage implements StorageAdapter {
  metadata: ObjectMetadata | null = null;
  prescribedKey = "";
  deleted: string[] = [];
  copied: Array<{ source: string; destination: string }> = [];
  contents = new Map<string, string>();
  copyFailure = false;
  finalHeadFailure = false;

  async createPutUrl(input: { objectKey: string }) {
    this.prescribedKey = input.objectKey;
    return `https://storage.example.test/upload?signature=secret`;
  }
  async headObject(objectKey: string) {
    if (objectKey.startsWith("profile-review/") && this.finalHeadFailure) return null;
    return this.metadata;
  }
  async copyObject(source: string, destination: string) {
    if (this.copyFailure) throw new Error("COPY_FAILED");
    this.copied.push({ source, destination });
    this.contents.set(destination, this.contents.get(source) ?? "");
  }
  async readPrefix() { return new Uint8Array(); }
  async deleteObject(objectKey: string) { this.deleted.push(objectKey); }
}

function fakeStore(): PhotoMediaStore & { created: number } {
  let upload: Awaited<ReturnType<PhotoMediaStore["reserveUpload"]>> | undefined;
  let completed: Awaited<ReturnType<PhotoMediaStore["completeUpload"]>> | null = null;
  return {
    created: 0,
    async reserveUpload(input) {
      upload ??= {
        id: crypto.randomUUID(),
        profileId: "5e03133c-8d16-48a5-8dc0-e3135327fd0f",
        ...input,
        completedPhotoId: null,
      };
      return upload;
    },
    async findUpload(_userId, uploadId) {
      return upload?.id === uploadId ? upload : null;
    },
    async completeUpload(_userId, uploadId, finalize) {
      if (completed) return completed;
      const finalized = await finalize(upload!);
      if (completed) return completed;
      this.created += 1;
      completed = {
        photo: { id: crypto.randomUUID(), moderationStatus: "pending", ...finalized },
        job: { id: crypto.randomUUID(), status: "pending" },
      };
      if (upload?.id === uploadId) upload.completedPhotoId = completed.photo.id;
      return completed;
    },
    async listPhotosForUser() { return []; },
    async markPhotoRemoved() { return true; },
  };
}

describe("signed profile photo uploads", () => {
  const s3Configuration = {
    endpoint: "https://storage.example.test", region: "us-east-1", bucket: "profile-media",
    accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key",
  };
  it("uses real AWS presigning without binding an empty-body CRC32 checksum", async () => {
    const adapter = new S3StorageAdapter({
      endpoint: "https://storage.example.test",
      region: "us-east-1",
      bucket: "profile-media",
      accessKeyId: "dummy-access-key",
      secretAccessKey: "dummy-secret-key",
    });
    const signed = new URL(await adapter.createPutUrl({
      objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png",
      sizeBytes: 123,
      expiresInSeconds: 300,
    }));
    expect(signed.searchParams.has("x-amz-checksum-crc32")).toBe(false);
    expect(signed.searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
  });
  it("generates an owned random key and never accepts a client object key", async () => {
    const storage = new FakeStorage();
    const store = fakeStore();
    const handler = createPhotoUploadHandler({
      getSession: async () => ({ user: { id: userId } }),
      storage,
      store,
      clock: () => new Date("2026-08-05T12:00:00Z"),
      tokenSecret: "test-upload-token-secret-at-least-32-bytes",
    });
    const invalid = await handler(new Request("http://localhost/api/v1/me/photos", {
      method: "POST",
      body: JSON.stringify({
        mimeType: "image/jpeg",
        sizeBytes: 100,
        idempotencyKey: "request-123",
        objectKey: "admin/chosen.jpg",
      }),
    }));
    expect(invalid.status).toBe(400);

    const response = await handler(new Request("http://localhost/api/v1/me/photos", {
      method: "POST",
      body: JSON.stringify({ mimeType: "image/jpeg", sizeBytes: 100, idempotencyKey: "request-123" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(storage.prescribedKey).toMatch(new RegExp(`^profile-media/${userId}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.jpg$`));
    expect(body).toMatchObject({
      uploadUrl: expect.stringContaining("signature=secret"),
      requiredHeaders: { "content-type": "image/jpeg", "content-length": "100" },
    });
    expect(new Date(body.expiresAt).getTime()).toBeLessThanOrEqual(Date.parse("2026-08-05T12:10:00Z"));
  });

  it.each([
    ["image/gif", 100],
    ["image/jpeg", 10 * 1024 * 1024 + 1],
  ])("rejects disallowed declaration %s %s", async (mimeType, sizeBytes) => {
    const handler = createPhotoUploadHandler({
      getSession: async () => ({ user: { id: userId } }),
      storage: new FakeStorage(),
      store: fakeStore(),
      tokenSecret: "test-upload-token-secret-at-least-32-bytes",
    });
    const response = await handler(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ mimeType, sizeBytes, idempotencyKey: "request-123" }),
    }));
    expect(response.status).toBe(400);
  });

  it("verifies HEAD metadata and ownership before atomically creating pending photo and job", async () => {
    const storage = new FakeStorage();
    const store = fakeStore();
    const now = new Date("2026-08-05T12:00:00Z");
    const upload = createPhotoUploadHandler({
      getSession: async () => ({ user: { id: userId } }), storage, store,
      clock: () => now, tokenSecret: "test-upload-token-secret-at-least-32-bytes",
    });
    const reserved = await (await upload(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ mimeType: "image/png", sizeBytes: 123, idempotencyKey: "complete-123" }),
    }))).json();
    const complete = createPhotoCompleteHandler({
      getSession: async () => ({ user: { id: userId } }), storage, store,
      clock: () => now, tokenSecret: "test-upload-token-secret-at-least-32-bytes",
    });

    storage.metadata = { sizeBytes: 122, mimeType: "image/png" };
    const mismatch = await complete(new Request("http://localhost", {
      method: "POST", body: JSON.stringify({ uploadId: reserved.uploadId, uploadToken: reserved.uploadToken }),
    }));
    expect(mismatch.status).toBe(409);
    expect(storage.deleted).toEqual([storage.prescribedKey]);
    expect(store.created).toBe(0);

    storage.metadata = { sizeBytes: 123, mimeType: "image/png" };
    storage.contents.set(storage.prescribedKey, "original-content");
    const first = await complete(new Request("http://localhost", {
      method: "POST", body: JSON.stringify({ uploadId: reserved.uploadId, uploadToken: reserved.uploadToken }),
    }));
    const second = await complete(new Request("http://localhost", {
      method: "POST", body: JSON.stringify({ uploadId: reserved.uploadId, uploadToken: reserved.uploadToken }),
    }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.created).toBe(1);
    expect(storage.copied).toHaveLength(1);
    expect(storage.copied[0]!.destination).toMatch(new RegExp(`^profile-review/${userId}/${reserved.uploadId}\\.png$`));
    storage.contents.set(storage.prescribedKey, "same-size-replayed");
    const third = await complete(new Request("http://localhost", {
      method: "POST", body: JSON.stringify({ uploadId: reserved.uploadId, uploadToken: reserved.uploadToken }),
    }));
    expect(third.status).toBe(200);
    expect(storage.copied).toHaveLength(1);
    expect(storage.contents.get(storage.copied[0]!.destination)).toBe("original-content");
    await expect(first.json()).resolves.toMatchObject({ photo: { status: "pending" } });
  });

  it.each(["copy", "head"])("does not commit a photo when immutable %s finalization fails", async (failure) => {
    const storage = new FakeStorage();
    const store = fakeStore();
    const upload = createPhotoUploadHandler({
      getSession: async () => ({ user: { id: userId } }), storage, store,
      tokenSecret: "test-upload-token-secret-at-least-32-bytes",
    });
    const reserved = await (await upload(new Request("http://localhost", {
      method: "POST", body: JSON.stringify({ mimeType: "image/png", sizeBytes: 123, idempotencyKey: `failure-${failure}` }),
    }))).json();
    storage.metadata = { sizeBytes: 123, mimeType: "image/png" };
    storage.copyFailure = failure === "copy";
    storage.finalHeadFailure = failure === "head";
    const response = await createPhotoCompleteHandler({
      getSession: async () => ({ user: { id: userId } }), storage, store,
      tokenSecret: "test-upload-token-secret-at-least-32-bytes",
    })(new Request("http://localhost", { method: "POST", body: JSON.stringify({
      uploadId: reserved.uploadId, uploadToken: reserved.uploadToken,
    }) }));
    expect(response.status).toBe(500);
    expect(store.created).toBe(0);
  });

  it("aborts bounded reads as soon as a backend ignores Range and streams too much", async () => {
    const controller = new AbortController();
    const body = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(4);
        yield new Uint8Array(5);
      },
    };
    await expect(collectBoundedBody(body, 8, controller)).rejects.toThrow("STORAGE_OBJECT_TOO_LARGE");
    expect(controller.signal.aborted).toBe(true);
  });

  it("passes controllable abort signals to S3 Head, Get, Copy, and Delete", async () => {
    const calls: string[] = [];
    const client = {
      async send(command: object, options?: { abortSignal?: AbortSignal }) {
        const name = command.constructor.name;
        calls.push(name);
        expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
        if (name === "HeadObjectCommand") return { ContentLength: 4, ContentType: "image/png" };
        if (name === "GetObjectCommand") return { Body: { async *[Symbol.asyncIterator]() { yield new Uint8Array(4); } } };
        return {};
      },
    };
    const adapter = new S3StorageAdapter({ ...s3Configuration, client: client as unknown as S3Client, requestTimeoutMs: 50 });
    await adapter.headObject("staging");
    await adapter.readPrefix("review", 4);
    await adapter.copyObject("staging", "review");
    await adapter.deleteObject("staging");
    expect(calls).toEqual(["HeadObjectCommand", "GetObjectCommand", "CopyObjectCommand", "DeleteObjectCommand"]);
  });

  it("times out a slow S3 response", async () => {
    const client = {
      send(_command: object, options?: { abortSignal?: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const adapter = new S3StorageAdapter({ ...s3Configuration, client: client as unknown as S3Client, requestTimeoutMs: 5 });
    await expect(adapter.headObject("slow")).rejects.toThrow("STORAGE_UNAVAILABLE");
  });

  it("requires authentication without calling storage", async () => {
    const storage = new FakeStorage();
    const spy = vi.spyOn(storage, "createPutUrl");
    const response = await createPhotoUploadHandler({
      getSession: async () => null,
      storage,
      store: fakeStore(),
      tokenSecret: "test-upload-token-secret-at-least-32-bytes",
    })(new Request("http://localhost", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("lists only safe owner photo state without object keys or provider internals", async () => {
    const response = await createPhotoListHandler({
      getSession: async () => ({ user: { id: userId } }),
      store: {
        ...fakeStore(),
        async listPhotosForUser() {
          return [{
            id: "photo-1", moderationStatus: "rejected", moderationReasonCode: "CONTENT_UNSAFE",
            objectKey: "private/object.png", reviewProvider: "secret-provider", width: 80, height: 60,
            createdAt: new Date("2026-08-05T12:00:00Z"),
          }];
        },
      },
    })(new Request("http://localhost/api/v1/me/photos"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ photos: [{
      id: "photo-1", status: "rejected", reason: "PHOTO_CONTENT_UNSAFE",
      width: 80, height: 60, createdAt: "2026-08-05T12:00:00.000Z",
    }] });
    expect(JSON.stringify(body)).not.toMatch(/objectKey|reviewProvider|secret-provider/);
  });
});
