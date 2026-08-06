// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  HttpsMediaReviewAdapter,
  InMemoryMediaReviewAdapter,
} from "@/modules/profiles/media-review-adapter";
import { MediaReviewStore } from "@/modules/profiles/media-review-store";
import type { StorageAdapter } from "@/modules/profiles/media-service";
import { cleanupRejectedMedia, processMediaReviewJobs } from "@/workers/media-review-worker";

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

class MemoryStorage implements StorageAdapter {
  bytes = png(800, 600);
  deleted: string[] = [];
  async createPutUrl() { return "https://storage.example.test/signed?secret=hidden"; }
  async headObject() { return { mimeType: "image/png", sizeBytes: this.bytes.length }; }
  async readPrefix(_key: string, maximumBytes: number) { return this.bytes.slice(0, maximumBytes); }
  async deleteObject(key: string) { this.deleted.push(key); }
}

describe("durable profile media review", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let store: MediaReviewStore;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    store = new MediaReviewStore(database, {
      maximumPhotos: 6,
      clock: () => new Date("2026-08-05T12:00:00Z"),
    });
    [{ id: userId }] = await database.insert(schema.users).values({ name: "Owner", email: "media@example.test" })
      .returning({ id: schema.users.id });
    await database.insert(schema.profiles).values({
      userId, displayName: "Owner", birthDate: "1990-01-01", genderCode: "self_described", countryCode: "US",
    });
  });

  afterEach(async () => client.close());

  async function pending(now = new Date("2026-08-05T12:00:00Z")) {
    const upload = await store.reserveUpload({
      userId,
      objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png",
      declaredSizeBytes: 24,
      tokenHash: "token-hash",
      idempotencyHash: "idem-hash",
      expiresAt: new Date(now.getTime() + 300_000),
    });
    return store.completeUpload(userId, upload.id, { mimeType: "image/png", sizeBytes: 24 });
  }

  it("completes upload idempotently with one pending photo and one job", async () => {
    const first = await pending();
    const second = await store.completeUpload(userId, (await store.findUpload(userId, (await database.select().from(schema.profilePhotoUploads))[0]!.id))!.id, {
      mimeType: "image/png", sizeBytes: 24,
    });
    expect(second.photo.id).toBe(first.photo.id);
    expect(await database.select().from(schema.profilePhotos)).toHaveLength(1);
    expect(await database.select().from(schema.mediaReviewJobs)).toHaveLength(1);
    expect(first.photo.moderationStatus).toBe("pending");
  });

  it("lets only one worker claim a job and recovers an expired lease", async () => {
    const { job } = await pending();
    const now = new Date("2026-08-05T12:00:00Z");
    const [first, competing] = await Promise.all([
      store.claimDue(now, 1_000, 1),
      store.claimDue(now, 1_000, 1),
    ]);
    expect(first.length + competing.length).toBe(1);
    const oldClaim = (first[0] ?? competing[0])!;
    const [recovered] = await store.claimDue(new Date(now.getTime() + 1_001), 1_000, 1);
    expect(recovered.id).toBe(job.id);
    expect(recovered.leaseId).not.toBe(oldClaim.leaseId);

    await expect(store.completeReview(oldClaim.id, oldClaim.leaseId!, {
      outcome: "rejected", provider: "stale", version: "v0", reasonCode: "STALE",
      width: 1, height: 1,
    }, now, 86_400_000)).resolves.toBe(false);
    await expect(store.completeReview(recovered.id, recovered.leaseId!, {
      outcome: "approved", provider: "test", version: "v1", width: 1, height: 1,
    }, new Date(now.getTime() + 1_002), 86_400_000)).resolves.toBe(true);
    const [photo] = await database.select().from(schema.profilePhotos);
    expect(photo).toMatchObject({ moderationStatus: "approved", reviewProvider: "test", reviewVersion: "v1" });
  });

  it("keeps retry failures redacted and schedules rejected evidence retention", async () => {
    const { photo } = await pending();
    const now = new Date("2026-08-05T12:00:00Z");
    const [claim] = await store.claimDue(now, 1_000, 1);
    await store.failReview(claim.id, claim.leaseId!, now, "MEDIA_REVIEW_PROVIDER_RETRY", 10);
    let [job] = await database.select().from(schema.mediaReviewJobs);
    expect(job).toMatchObject({ status: "pending", attempts: 1, lastError: "MEDIA_REVIEW_PROVIDER_RETRY" });
    expect(job.lastError).not.toContain("secret");

    [job] = await database.update(schema.mediaReviewJobs).set({ availableAt: now }).where(eq(schema.mediaReviewJobs.id, job.id)).returning();
    const [retry] = await store.claimDue(now, 1_000, 1);
    await store.completeReview(retry.id, retry.leaseId!, {
      outcome: "rejected", provider: "test", version: "v1", reasonCode: "CONTENT_UNSAFE", width: 1, height: 1,
    }, now, 86_400_000);
    const [rejected] = await database.select().from(schema.profilePhotos).where(eq(schema.profilePhotos.id, photo.id));
    expect(rejected.moderationStatus).toBe("rejected");
    expect(rejected.cleanupDueAt).toEqual(new Date(now.getTime() + 86_400_000));
    expect(rejected.objectDeletedAt).toBeNull();
  });

  it("runs provider approve, signature rejection, and retry paths without publishing pending media", async () => {
    const now = new Date("2026-08-05T12:00:00Z");
    const storage = new MemoryStorage();
    const { photo } = await pending();
    await processMediaReviewJobs({
      store,
      storage,
      adapter: new InMemoryMediaReviewAdapter([{ outcome: "approved", provider: "test", version: "v1" }]),
      clock: () => now,
    });
    let [row] = await database.select().from(schema.profilePhotos).where(eq(schema.profilePhotos.id, photo.id));
    expect(row).toMatchObject({ moderationStatus: "approved", width: 800, height: 600 });

    const [{ job: signatureJob }] = await Promise.all([
      (async () => {
        await database.update(schema.profilePhotoUploads).set({ idempotencyHash: "old-idem" })
          .where(eq(schema.profilePhotoUploads.idempotencyHash, "idem-hash"));
        return pending();
      })(),
    ]);
    storage.bytes = new Uint8Array(24);
    await processMediaReviewJobs({
      store,
      storage,
      adapter: new InMemoryMediaReviewAdapter(),
      clock: () => now,
    });
    [row] = await database.select().from(schema.profilePhotos).where(eq(schema.profilePhotos.id, signatureJob.photoId));
    expect(row).toMatchObject({ moderationStatus: "rejected", moderationReasonCode: "SIGNATURE_MIME_MISMATCH" });

    await database.update(schema.profilePhotoUploads).set({ idempotencyHash: "old-idem-2" })
      .where(eq(schema.profilePhotoUploads.idempotencyHash, "idem-hash"));
    const { job: retryJob } = await pending();
    storage.bytes = png(1, 1);
    await processMediaReviewJobs({
      store,
      storage,
      adapter: new HttpsMediaReviewAdapter(),
      clock: () => now,
    });
    const [retried] = await database.select().from(schema.mediaReviewJobs).where(eq(schema.mediaReviewJobs.id, retryJob.id));
    expect(retried).toMatchObject({ status: "pending", attempts: 1, lastError: "MEDIA_REVIEW_PROVIDER_RETRY" });
  });

  it("retains rejected evidence until due and then deletes idempotently", async () => {
    const now = new Date("2026-08-05T12:00:00Z");
    const storage = new MemoryStorage();
    const { photo } = await pending();
    await processMediaReviewJobs({
      store,
      storage,
      adapter: new InMemoryMediaReviewAdapter([{
        outcome: "rejected", provider: "test", version: "v1", reasonCode: "CONTENT_UNSAFE",
      }]),
      clock: () => now,
      rejectedRetentionMs: 1_000,
    });
    expect(await cleanupRejectedMedia({ store, storage, clock: () => new Date(now.getTime() + 999) })).toBe(0);
    expect(storage.deleted).toHaveLength(0);
    expect(await cleanupRejectedMedia({ store, storage, clock: () => new Date(now.getTime() + 1_000) })).toBe(1);
    expect(storage.deleted).toEqual([photo.objectKey]);
    expect(await cleanupRejectedMedia({ store, storage, clock: () => new Date(now.getTime() + 2_000) })).toBe(0);
  });
});
