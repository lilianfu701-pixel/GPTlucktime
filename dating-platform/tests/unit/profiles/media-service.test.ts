// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createPhotoCompleteHandler,
  createPhotoUploadHandler,
  type ObjectMetadata,
  type PhotoMediaStore,
  type StorageAdapter,
} from "@/modules/profiles/media-service";

const userId = "83e8d1e5-e2c1-4190-828f-30751db022a3";

class FakeStorage implements StorageAdapter {
  metadata: ObjectMetadata | null = null;
  prescribedKey = "";
  deleted: string[] = [];

  async createPutUrl(input: { objectKey: string }) {
    this.prescribedKey = input.objectKey;
    return `https://storage.example.test/upload?signature=secret`;
  }
  async headObject() { return this.metadata; }
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
    async completeUpload(_userId, uploadId, metadata) {
      if (completed) return completed;
      this.created += 1;
      completed = {
        photo: { id: crypto.randomUUID(), moderationStatus: "pending", ...metadata },
        job: { id: crypto.randomUUID(), status: "pending" },
      };
      if (upload?.id === uploadId) upload.completedPhotoId = completed.photo.id;
      return completed;
    },
  };
}

describe("signed profile photo uploads", () => {
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
    const first = await complete(new Request("http://localhost", {
      method: "POST", body: JSON.stringify({ uploadId: reserved.uploadId, uploadToken: reserved.uploadToken }),
    }));
    const second = await complete(new Request("http://localhost", {
      method: "POST", body: JSON.stringify({ uploadId: reserved.uploadId, uploadToken: reserved.uploadToken }),
    }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.created).toBe(1);
    await expect(first.json()).resolves.toMatchObject({ photo: { moderationStatus: "pending" } });
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
});
