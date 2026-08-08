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
import {
  cleanupRejectedMedia,
  cleanupUploadArtifacts,
  drainMediaWorkers,
  processMediaReviewJobs,
} from "@/workers/media-review-worker";

const sharp = getProfileSharp();

class MemoryStorage implements StorageAdapter {
  bytes: Uint8Array;
  deleted: string[] = [];
  failDeletes = 0;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  async createPutUrl() { return "https://storage.example.test/signed?secret=hidden"; }
  async headObject() { return { mimeType: "image/png", sizeBytes: this.bytes.length, etag: "memory-etag" }; }
  async copyObject() {}
  async readPrefix(_key: string, maximumBytes: number) { return this.bytes.slice(0, maximumBytes); }
  async deleteObject(key: string) {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("simulated object deletion failure");
    }
    this.deleted.push(key);
  }
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

  it("leases durable finalization, recovers expiration, and replays the committed result", async () => {
    const upload = await store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "lease-token",
      idempotencyHash: "lease-finalization", expiresAt: new Date(storeNow.getTime() + 300_000),
    });
    const durable = store as unknown as {
      claimUploadFinalization(userId: string, uploadId: string, now: Date, leaseMs: number): Promise<Record<string, unknown>>;
      bindUploadSourceEtag(uploadId: string, leaseId: string, etag: string, now: Date): Promise<boolean>;
      commitUploadFinalization(userId: string, uploadId: string, leaseId: string, metadata: {
        objectKey: string; mimeType: string; sizeBytes: number;
      }, now: Date): Promise<Record<string, unknown>>;
    };
    const first = await durable.claimUploadFinalization(userId, upload.id, storeNow, 1_000);
    expect(first).toMatchObject({ state: "claimed", upload: { id: upload.id }, leaseId: expect.any(String) });
    const busy = await durable.claimUploadFinalization(userId, upload.id, storeNow, 1_000);
    expect(busy).toMatchObject({ state: "busy" });
    storeNow = new Date(storeNow.getTime() + 1_001);
    const recovered = await durable.claimUploadFinalization(userId, upload.id, storeNow, 1_000);
    expect(recovered).toMatchObject({ state: "claimed" });
    expect(recovered.leaseId).not.toBe(first.leaseId);
    await expect(durable.bindUploadSourceEtag(upload.id, String(recovered.leaseId), "etag-v1", storeNow))
      .resolves.toBe(true);
    await expect(durable.bindUploadSourceEtag(upload.id, String(recovered.leaseId), "etag-v2", storeNow))
      .resolves.toBe(false);
    const finalObjectKey = `profile-review/${userId}/${upload.id}.png`;
    const committed = await durable.commitUploadFinalization(userId, upload.id, String(recovered.leaseId), {
      objectKey: finalObjectKey, mimeType: "image/png", sizeBytes: 24,
    }, storeNow);
    expect(committed).toMatchObject({ photo: { objectKey: finalObjectKey }, job: { status: "pending" } });
    const replay = await durable.claimUploadFinalization(userId, upload.id, storeNow, 1_000);
    expect(replay).toMatchObject({ state: "completed", result: { photo: { id: expect.any(String) } } });
  });

  it("refuses an expired finalize lease so cleanup cannot race a stale commit", async () => {
    const upload = await store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "stale-lease-token",
      idempotencyHash: "stale-lease-commit", expiresAt: new Date(storeNow.getTime() + 300_000),
    });
    const claim = await store.claimUploadFinalization(userId, upload.id, storeNow, 50);
    expect(claim.state).toBe("claimed");
    if (claim.state !== "claimed") throw new Error("expected claim");
    storeNow = new Date(storeNow.getTime() + 51);
    await expect(store.commitUploadFinalization(userId, upload.id, claim.leaseId, {
      objectKey: claim.upload.finalObjectKey!, mimeType: "image/png", sizeBytes: 24, etag: "final-etag",
    }, storeNow)).rejects.toThrow("UPLOAD_FINALIZATION_LEASE_LOST");
    expect(await database.select().from(schema.profilePhotos)).toHaveLength(0);
    expect(await database.select().from(schema.mediaReviewJobs)).toHaveLength(0);
  });

  it("makes cleanup wait for a commit row lock and never authorizes final deletion after commit", async () => {
    const upload = await store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "cleanup-race-token",
      idempotencyHash: "commit-first-race", expiresAt: new Date(storeNow.getTime() + 50),
    });
    const claim = await store.claimUploadFinalization(userId, upload.id, storeNow, 50);
    if (claim.state !== "claimed") throw new Error("expected claim");
    const cleanupNow = new Date(storeNow.getTime() + 51);
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const committedPhotoId = crypto.randomUUID();
    const committing = database.transaction(async (transaction) => {
      await transaction.select().from(schema.profilePhotoUploads)
        .where(eq(schema.profilePhotoUploads.id, upload.id)).for("update");
      signalLocked();
      await commitGate;
      await transaction.update(schema.profilePhotoUploads).set({
        completedPhotoId: committedPhotoId,
        finalizationStatus: "finalized",
        finalizationLeaseId: null,
        finalizationLeaseExpiresAt: null,
        stagingCleanupDueAt: cleanupNow,
        finalOrphanCleanupDueAt: null,
      }).where(eq(schema.profilePhotoUploads.id, upload.id));
    });
    await locked;
    let cleanupSettled = false;
    const cleaning = store.claimUploadArtifactCleanup(upload.id, cleanupNow)
      .then((value) => { cleanupSettled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cleanupSettled).toBe(false);
    releaseCommit();
    await committing;
    await expect(cleaning).resolves.toMatchObject({
      deleteFinalObjectKey: null,
      deleteStagingObjectKey: upload.objectKey,
    });
  });

  it("lets cleanup claim first invalidate the stale finalize lease before deleting an orphan", async () => {
    const upload = await store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "cleanup-first-token",
      idempotencyHash: "cleanup-first-race", expiresAt: new Date(storeNow.getTime() + 50),
    });
    const claim = await store.claimUploadFinalization(userId, upload.id, storeNow, 50);
    if (claim.state !== "claimed") throw new Error("expected claim");
    const cleanupNow = new Date(storeNow.getTime() + 51);
    await expect(store.claimUploadArtifactCleanup(upload.id, cleanupNow)).resolves.toMatchObject({
      deleteFinalObjectKey: claim.upload.finalObjectKey,
      deleteStagingObjectKey: upload.objectKey,
    });
    await expect(store.commitUploadFinalization(userId, upload.id, claim.leaseId, {
      objectKey: claim.upload.finalObjectKey!, mimeType: "image/png", sizeBytes: 24, etag: "final-etag",
    }, new Date(storeNow.getTime() + 49))).rejects.toThrow("UPLOAD_FINALIZATION_LEASE_LOST");
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
    let [removedPhoto] = await database.select().from(schema.profilePhotos)
      .where(eq(schema.profilePhotos.id, photo.id));
    expect(removedPhoto.cleanupDueAt).toEqual(storeNow);

    const storage = new MemoryStorage(new Uint8Array());
    storage.failDeletes = 1;
    await expect(cleanupRejectedMedia({ store, storage, clock: () => storeNow })).resolves.toBe(0);
    [removedPhoto] = await database.select().from(schema.profilePhotos)
      .where(eq(schema.profilePhotos.id, photo.id));
    expect(removedPhoto.objectDeletedAt).toBeNull();
    await expect(cleanupRejectedMedia({ store, storage, clock: () => storeNow })).resolves.toBe(1);
    [removedPhoto] = await database.select().from(schema.profilePhotos)
      .where(eq(schema.profilePhotos.id, photo.id));
    expect(removedPhoto.objectDeletedAt).toEqual(storeNow);
    expect(storage.deleted).toEqual([photo.objectKey]);
    expect(await database.select().from(schema.profilePhotos)
      .where(eq(schema.profilePhotos.id, photo.id))).toHaveLength(1);
    await expect(cleanupRejectedMedia({ store, storage, clock: () => storeNow })).resolves.toBe(0);

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

  it("keeps cleanup due when removal races an in-flight approval", async () => {
    const storage = new MemoryStorage(new Uint8Array(24));
    const { photo, job } = await pending(24);
    const [claim] = await store.claimDue(storeNow, 1_000, 1);
    await expect(store.markPhotoRemoved(userId, photo.id)).resolves.toBe(true);
    await expect(store.completeReview(job.id, claim.leaseId!, {
      outcome: "approved", provider: "test", version: "v1", width: 10, height: 10,
    }, storeNow)).resolves.toBe(true);
    const [removed] = await database.select().from(schema.profilePhotos)
      .where(eq(schema.profilePhotos.id, photo.id));
    expect(removed.userRemovedAt).toEqual(storeNow);
    expect(removed.cleanupDueAt).toEqual(storeNow);
    await expect(cleanupRejectedMedia({ store, storage, clock: () => storeNow })).resolves.toBe(1);
    const [cleaned] = await database.select().from(schema.profilePhotos)
      .where(eq(schema.profilePhotos.id, photo.id));
    expect(cleaned.objectDeletedAt).toEqual(storeNow);
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

  it("bounds worker retries and records one immutable internal terminal result", async () => {
    const now = new Date("2026-08-05T12:00:00Z");
    const realPng = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#111827" } }).png().toBuffer();
    const storage = new MemoryStorage(realPng);
    const { photo } = await pending(realPng.length);
    const retryingAdapter = new HttpsMediaReviewAdapter();

    await processMediaReviewJobs({
      store, storage, adapter: retryingAdapter, clock: () => now, maxAttempts: 2,
    });
    await database.update(schema.mediaReviewJobs).set({ availableAt: now });
    const terminalRuns = await Promise.all([
      processMediaReviewJobs({ store, storage, adapter: retryingAdapter, clock: () => now, maxAttempts: 2 }),
      processMediaReviewJobs({ store, storage, adapter: retryingAdapter, clock: () => now, maxAttempts: 2 }),
    ]);

    expect(terminalRuns.reduce((sum, count) => sum + count, 0)).toBe(1);
    const [job] = await database.select().from(schema.mediaReviewJobs);
    const [terminalPhoto] = await database.select().from(schema.profilePhotos)
      .where(eq(schema.profilePhotos.id, photo.id));
    const results = await database.select().from(schema.mediaReviewResults);
    const [upload] = await database.select().from(schema.profilePhotoUploads);
    expect(job).toMatchObject({ status: "failed", attempts: 2 });
    expect(terminalPhoto).toMatchObject({
      moderationStatus: "rejected",
      moderationReasonCode: "MEDIA_REVIEW_FAILED",
    });
    expect(terminalPhoto.cleanupDueAt).toBeInstanceOf(Date);
    expect(upload.quotaSlot).toBeNull();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      jobId: job.id,
      photoId: photo.id,
      attempt: 2,
      provider: "internal",
      providerVersion: "retry-v1",
      outcome: "rejected",
      reasonCode: "MEDIA_REVIEW_FAILED",
    });
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

  it("durably retries staging deletion and records final artifact cleanup", async () => {
    const storage = new MemoryStorage(new Uint8Array(24));
    const { photo } = await pending(24);
    storage.failDeletes = 1;
    await expect(cleanupUploadArtifacts({ store, storage, clock: () => storeNow })).resolves.toBe(0);
    let [upload] = await database.select().from(schema.profilePhotoUploads);
    expect(upload.stagingDeletedAt).toBeNull();
    await expect(cleanupUploadArtifacts({ store, storage, clock: () => storeNow })).resolves.toBe(1);
    [upload] = await database.select().from(schema.profilePhotoUploads);
    expect(upload.stagingDeletedAt).toEqual(storeNow);
    expect(upload.completedPhotoId).toBe(photo.id);
    expect(storage.deleted).toEqual([upload.objectKey]);
    await expect(cleanupUploadArtifacts({ store, storage, clock: () => storeNow })).resolves.toBe(0);
  });

  it("cleans a deterministic uncommitted final orphan without listing the bucket", async () => {
    const upload = await store.reserveUpload({
      userId, objectKey: `profile-media/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`,
      mimeType: "image/png", declaredSizeBytes: 24, tokenHash: "orphan-token",
      idempotencyHash: "orphan-final", expiresAt: new Date(storeNow.getTime() + 100),
    });
    const claim = await store.claimUploadFinalization(userId, upload.id, storeNow, 50);
    expect(claim.state).toBe("claimed");
    const finalObjectKey = claim.state === "claimed" ? claim.upload.finalObjectKey! : "";
    storeNow = new Date(storeNow.getTime() + 101);
    const storage = new MemoryStorage(new Uint8Array(24));
    await expect(cleanupUploadArtifacts({ store, storage, clock: () => storeNow })).resolves.toBe(2);
    const [cleaned] = await database.select().from(schema.profilePhotoUploads)
      .where(eq(schema.profilePhotoUploads.id, upload.id));
    expect(cleaned.stagingDeletedAt).toEqual(storeNow);
    expect(cleaned.finalOrphanDeletedAt).toEqual(storeNow);
    expect(cleaned.completedPhotoId).toBeNull();
    expect(storage.deleted.sort()).toEqual([finalObjectKey, upload.objectKey].sort());
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
    expect(first).toEqual({ reviewed: 1, deleted: 0, uploadArtifactsDeleted: 1 });
    const due = await drainMediaWorkers({
      store,
      storage,
      adapter: new InMemoryMediaReviewAdapter(),
      clock: () => new Date(now.getTime() + 1_000),
      rejectedRetentionMs: 1_000,
    });
    expect(due).toEqual({ reviewed: 0, deleted: 1, uploadArtifactsDeleted: 0 });
    await expect(drainMediaWorkers({
      store, storage, adapter: new InMemoryMediaReviewAdapter(),
      clock: () => new Date(now.getTime() + 2_000), rejectedRetentionMs: 1_000,
    })).resolves.toEqual({ reviewed: 0, deleted: 0, uploadArtifactsDeleted: 0 });
  });
});
