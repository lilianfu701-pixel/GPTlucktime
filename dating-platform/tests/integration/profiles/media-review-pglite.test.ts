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
import { ProfileRepository } from "@/modules/profiles/profile-repository";
import { getProfileSharp } from "@/modules/profiles/sharp-runtime";
import { cleanupRejectedMedia, drainMediaWorkers, processMediaReviewJobs } from "@/workers/media-review-worker";

const sharp = getProfileSharp();

class MemoryStorage implements StorageAdapter {
  bytes: Uint8Array;
  deleted: string[] = [];
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  async createPutUrl() { return "https://storage.example.test/signed?secret=hidden"; }
  async headObject() { return { mimeType: "image/png", sizeBytes: this.bytes.length }; }
  async copyObject() {}
  async readPrefix(_key: string, maximumBytes: number) { return this.bytes.slice(0, maximumBytes); }
  async deleteObject(key: string) { this.deleted.push(key); }
}

describe("durable profile media review", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let store: MediaReviewStore;
  let storeNow: Date;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    storeNow = new Date("2026-08-05T12:00:00Z");
    store = new MediaReviewStore(database, {
      maximumPhotos: 6,
      clock: () => storeNow,
    });
    [{ id: userId }] = await database.insert(schema.users).values({ name: "Owner", email: "media@example.test" })
      .returning({ id: schema.users.id });
    await database.insert(schema.profiles).values({
      userId, displayName: "Owner", birthDate: "1990-01-01", genderCode: "self_described", countryCode: "US",
    });
  });

  afterEach(async () => client.close());

  async function pending(sizeBytes = 24, now = new Date("2026-08-05T12:00:00Z")) {
    const upload = await store.reserveUpload({
      userId,
      objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png",
      declaredSizeBytes: sizeBytes,
      tokenHash: "token-hash",
      idempotencyHash: "idem-hash",
      expiresAt: new Date(now.getTime() + 300_000),
    });
    return store.completeUpload(userId, upload.id, async () => ({
      mimeType: "image/png", sizeBytes, objectKey: `profile-review/${userId}/${upload.id}.png`,
    }));
  }

  it("completes upload idempotently with one pending photo and one job", async () => {
    const first = await pending();
    const existingUpload = (await database.select().from(schema.profilePhotoUploads))[0]!;
    const second = await store.completeUpload(userId, existingUpload.id, async () => ({
      mimeType: "image/png", sizeBytes: 24, objectKey: `profile-review/${userId}/${existingUpload.id}.png`,
    }));
    expect(second.photo.id).toBe(first.photo.id);
    expect(await database.select().from(schema.profilePhotos)).toHaveLength(1);
    expect(await database.select().from(schema.mediaReviewJobs)).toHaveLength(1);
    expect(first.photo.moderationStatus).toBe("pending");
  });

  it("serializes concurrent immutable finalization so the copy callback runs once", async () => {
    const upload = await store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "concurrent-token",
      idempotencyHash: "concurrent-complete", expiresAt: new Date(storeNow.getTime() + 300_000),
    });
    let finalizations = 0;
    const finalize = async () => {
      finalizations += 1;
      await Promise.resolve();
      return { mimeType: "image/png", sizeBytes: 24, objectKey: `profile-review/${userId}/${upload.id}.png` };
    };
    const [first, second] = await Promise.all([
      store.completeUpload(userId, upload.id, finalize),
      store.completeUpload(userId, upload.id, finalize),
    ]);
    expect(second.photo.id).toBe(first.photo.id);
    expect(finalizations).toBe(1);
    expect(await database.select().from(schema.profilePhotos)).toHaveLength(1);
  });

  it("refuses to persist a staging key across the repository trust boundary", async () => {
    const upload = await store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "boundary-token",
      idempotencyHash: "boundary-final-key", expiresAt: new Date(storeNow.getTime() + 300_000),
    });
    await expect(store.completeUpload(userId, upload.id, async () => ({
      mimeType: "image/png", sizeBytes: 24, objectKey: upload.objectKey,
    }))).rejects.toThrow("INVALID_FINAL_MEDIA_KEY");
    expect(await database.select().from(schema.profilePhotos)).toHaveLength(0);
  });

  it("rechecks token expiry inside the locked completion transaction", async () => {
    const upload = await store.reserveUpload({
      userId,
      objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png",
      declaredSizeBytes: 24,
      tokenHash: "expiring-token",
      idempotencyHash: "expiring-idem",
      expiresAt: new Date(storeNow.getTime() + 50),
    });
    storeNow = new Date(storeNow.getTime() + 51);
    await expect(store.completeUpload(userId, upload.id, async () => ({
      mimeType: "image/png", sizeBytes: 24, objectKey: `profile-review/${userId}/${upload.id}.png`,
    })))
      .rejects.toThrow("UPLOAD_EXPIRED");
    expect(await database.select().from(schema.profilePhotos)).toHaveLength(0);
    expect(await database.select().from(schema.mediaReviewJobs)).toHaveLength(0);
  });

  it("serializes concurrent reservations so quota cannot be exceeded", async () => {
    store = new MediaReviewStore(database, { maximumPhotos: 1, clock: () => storeNow });
    const reserve = (suffix: string) => store.reserveUpload({
      userId,
      objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png",
      declaredSizeBytes: 24,
      tokenHash: `token-${suffix}`,
      idempotencyHash: `idem-${suffix}`,
      expiresAt: new Date(storeNow.getTime() + 300_000),
    });
    const results = await Promise.allSettled([reserve("a"), reserve("b")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await database.select().from(schema.profilePhotoUploads)).toHaveLength(1);
  });

  it("atomically releases one quota slot and hides the profile when the last approved photo is removed", async () => {
    store = new MediaReviewStore(database, { maximumPhotos: 1, clock: () => storeNow });
    const { photo, job } = await pending();
    const [claim] = await store.claimDue(storeNow, 1_000, 1);
    await store.completeReview(job.id, claim.leaseId!, {
      outcome: "approved", provider: "test", version: "v1", width: 10, height: 10,
    }, storeNow);
    await database.update(schema.profiles).set({
      status: "active", discoverable: true, publishRequested: true,
    }).where(eq(schema.profiles.userId, userId));

    const removed = await Promise.all([
      store.markPhotoRemoved(userId, photo.id),
      store.markPhotoRemoved(userId, photo.id),
    ]);
    expect(removed.sort()).toEqual([false, true]);
    const [upload] = await database.select().from(schema.profilePhotoUploads);
    const [profile] = await database.select().from(schema.profiles).where(eq(schema.profiles.userId, userId));
    expect(upload.quotaSlot).toBeNull();
    expect(profile).toMatchObject({ status: "draft", discoverable: false, publishRequested: false });
    expect((await new ProfileRepository(database).getForUser(userId))?.approvedPhotoCount).toBe(0);

    const reserveReplacement = (suffix: string) => store.reserveUpload({
      userId,
      objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: `replacement-${suffix}`,
      idempotencyHash: `replacement-${suffix}`, expiresAt: new Date(storeNow.getTime() + 300_000),
    });
    const replacements = await Promise.allSettled([reserveReplacement("a"), reserveReplacement("b")]);
    expect(replacements.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(replacements.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("releases quota for rejected and terminally failed photos", async () => {
    store = new MediaReviewStore(database, { maximumPhotos: 1, clock: () => storeNow });
    const rejectedPending = await pending();
    let [claim] = await store.claimDue(storeNow, 1_000, 1);
    const rejectedDecision = {
      outcome: "rejected", provider: "test", version: "v1", reasonCode: "CONTENT_UNSAFE",
      width: 10, height: 10,
    } as const;
    await expect(store.completeReview(rejectedPending.job.id, claim.leaseId!, rejectedDecision, storeNow))
      .resolves.toBe(true);
    await expect(store.completeReview(rejectedPending.job.id, claim.leaseId!, rejectedDecision, storeNow))
      .resolves.toBe(false);
    await expect(store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "after-rejected",
      idempotencyHash: "after-rejected", expiresAt: new Date(storeNow.getTime() + 300_000),
    })).resolves.toBeTruthy();

    const replacement = (await database.select().from(schema.profilePhotoUploads))
      .find((upload) => upload.idempotencyHash === "after-rejected")!;
    const failed = await store.completeUpload(userId, replacement.id, async () => ({
      mimeType: "image/png", sizeBytes: 24, objectKey: `profile-review/${userId}/${replacement.id}.png`,
    }));
    [claim] = await store.claimDue(storeNow, 1_000, 1);
    expect(claim.id).toBe(failed.job.id);
    const terminalFailures = await Promise.all([
      store.failReview(claim.id, claim.leaseId!, storeNow, "MEDIA_REVIEW_PROVIDER_RETRY", 1),
      store.failReview(claim.id, claim.leaseId!, storeNow, "MEDIA_REVIEW_PROVIDER_RETRY", 1),
    ]);
    expect(terminalFailures.sort()).toEqual([false, true]);
    await expect(store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "after-failed",
      idempotencyHash: "after-failed", expiresAt: new Date(storeNow.getTime() + 300_000),
    })).resolves.toBeTruthy();
    const [failedPhoto] = await database.select().from(schema.profilePhotos)
      .where(eq(schema.profilePhotos.id, failed.photo.id));
    expect(failedPhoto).toMatchObject({ moderationStatus: "rejected", moderationReasonCode: "MEDIA_REVIEW_FAILED" });
  });

  it("reclaims an expired slot exactly once under concurrent replacement reservations", async () => {
    store = new MediaReviewStore(database, { maximumPhotos: 1, clock: () => storeNow });
    await store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "expired",
      idempotencyHash: "expired", expiresAt: new Date(storeNow.getTime() + 1),
    });
    storeNow = new Date(storeNow.getTime() + 2);
    const replacement = (suffix: string) => store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: `expired-${suffix}`,
      idempotencyHash: `expired-${suffix}`, expiresAt: new Date(storeNow.getTime() + 300_000),
    });
    const results = await Promise.allSettled([replacement("a"), replacement("b")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const uploads = await database.select().from(schema.profilePhotoUploads);
    expect(uploads.filter((upload) => upload.quotaSlot !== null)).toHaveLength(1);
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
    expect(await database.select().from(schema.mediaReviewResults)).toHaveLength(1);
    await expect(store.completeReview(recovered.id, recovered.leaseId!, {
      outcome: "rejected", provider: "duplicate", version: "v2", reasonCode: "DUPLICATE", width: 1, height: 1,
    }, new Date(now.getTime() + 2_000), 86_400_000)).resolves.toBe(false);
    const [immutable] = await database.select().from(schema.mediaReviewResults);
    expect(immutable).toMatchObject({ outcome: "approved", provider: "test", providerVersion: "v1" });
    await expect(client.exec(`update media_review_results set outcome = 'rejected' where id = '${immutable.id}'`))
      .rejects.toThrow("MEDIA_REVIEW_RESULTS_APPEND_ONLY");
    await expect(client.exec(`delete from media_review_results where id = '${immutable.id}'`))
      .rejects.toThrow("MEDIA_REVIEW_RESULTS_APPEND_ONLY");
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
    const realPng = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#111827" } }).png().toBuffer();
    const storage = new MemoryStorage(realPng);
    const { photo } = await pending(storage.bytes.length);
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
        return pending(storage.bytes.length);
      })(),
    ]);
    storage.bytes = new Uint8Array(storage.bytes.length);
    await processMediaReviewJobs({
      store,
      storage,
      adapter: new InMemoryMediaReviewAdapter(),
      clock: () => now,
    });
    [row] = await database.select().from(schema.profilePhotos).where(eq(schema.profilePhotos.id, signatureJob.photoId));
    expect(row).toMatchObject({ moderationStatus: "rejected", moderationReasonCode: "IMAGE_METADATA_INVALID" });

    await database.update(schema.profilePhotoUploads).set({ idempotencyHash: "old-idem-2" })
      .where(eq(schema.profilePhotoUploads.idempotencyHash, "idem-hash"));
    storage.bytes = realPng;
    const { job: retryJob } = await pending(storage.bytes.length);
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
    const realPng = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#111827" } }).png().toBuffer();
    const storage = new MemoryStorage(realPng);
    const { photo } = await pending(storage.bytes.length);
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

  it("exports one production tick that drains review jobs and due cleanup", async () => {
    const now = new Date("2026-08-05T12:00:00Z");
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#111827" } }).png().toBuffer();
    const storage = new MemoryStorage(bytes);
    await pending(bytes.length);
    const first = await drainMediaWorkers({
      store,
      storage,
      adapter: new InMemoryMediaReviewAdapter([{
        outcome: "rejected", provider: "test", version: "v1", reasonCode: "CONTENT_UNSAFE",
      }]),
      clock: () => now,
      rejectedRetentionMs: 1_000,
    });
    expect(first).toEqual({ reviewed: 1, deleted: 0 });
    const due = await drainMediaWorkers({
      store,
      storage,
      adapter: new InMemoryMediaReviewAdapter(),
      clock: () => new Date(now.getTime() + 1_000),
      rejectedRetentionMs: 1_000,
    });
    expect(due).toEqual({ reviewed: 0, deleted: 1 });
    await expect(drainMediaWorkers({
      store, storage, adapter: new InMemoryMediaReviewAdapter(),
      clock: () => new Date(now.getTime() + 2_000), rejectedRetentionMs: 1_000,
    })).resolves.toEqual({ reviewed: 0, deleted: 0 });
  });
});
