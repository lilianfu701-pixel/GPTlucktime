import { randomUUID } from "node:crypto";

import { and, asc, count, eq, inArray, isNotNull, isNull, lte, max, ne, or } from "drizzle-orm";

import {
  mediaReviewJobs,
  mediaReviewResults,
  profilePhotoUploads,
  profilePhotos,
  profiles,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import type { PhotoMediaStore, ReservedUploadInput } from "./media-service";

type MediaDatabase = typeof productionDatabase;
type ReviewOutcome = {
  outcome: "approved" | "rejected";
  provider: string;
  version: string;
  reasonCode?: string;
  width: number;
  height: number;
};

const permittedErrors = new Set([
  "MEDIA_REVIEW_PROVIDER_RETRY",
  "MEDIA_REVIEW_STORAGE_RETRY",
  "MEDIA_REVIEW_FAILED",
]);

const extensionForMime: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export class MediaReviewStore implements PhotoMediaStore {
  readonly database: MediaDatabase;
  private readonly maximumPhotos: number;
  private readonly clock: () => Date;

  constructor(database: unknown, options: { maximumPhotos?: number; clock?: () => Date } = {}) {
    this.database = database as MediaDatabase;
    this.maximumPhotos = options.maximumPhotos ?? 6;
    this.clock = options.clock ?? (() => new Date());
  }

  async reserveUpload(input: ReservedUploadInput) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const [existing] = await tx.select().from(profilePhotoUploads).where(and(
        eq(profilePhotoUploads.userId, input.userId),
        eq(profilePhotoUploads.idempotencyHash, input.idempotencyHash),
      ));
      if (existing) return existing;
      const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, input.userId)).for("update");
      if (!profile) throw new Error("PROFILE_REQUIRED");
      const now = this.clock();
      await tx.update(profilePhotoUploads).set({ quotaSlot: null, updatedAt: now }).where(and(
        eq(profilePhotoUploads.userId, input.userId),
        isNull(profilePhotoUploads.completedPhotoId),
        lte(profilePhotoUploads.expiresAt, now),
      ));
      const [{ value: legacyPhotos }] = await tx.select({ value: count() }).from(profilePhotos).where(and(
        eq(profilePhotos.userId, input.userId),
        isNull(profilePhotos.uploadId),
        isNull(profilePhotos.userRemovedAt),
        inArray(profilePhotos.moderationStatus, ["pending", "approved"]),
      ));
      const availableSlots = Math.max(0, this.maximumPhotos - Number(legacyPhotos));
      for (let quotaSlot = 0; quotaSlot < availableSlots; quotaSlot += 1) {
        const [created] = await tx.insert(profilePhotoUploads).values({
          ...input,
          profileId: profile.id,
          quotaSlot,
        }).onConflictDoNothing().returning();
        if (created) return created;
      }
      const [concurrentRetry] = await tx.select().from(profilePhotoUploads).where(and(
        eq(profilePhotoUploads.userId, input.userId),
        eq(profilePhotoUploads.idempotencyHash, input.idempotencyHash),
      ));
      if (concurrentRetry) return concurrentRetry;
      throw new Error("PHOTO_QUOTA_EXCEEDED");
    });
  }

  async findUpload(userId: string, uploadId: string) {
    const [upload] = await this.database.select().from(profilePhotoUploads).where(and(
      eq(profilePhotoUploads.id, uploadId),
      eq(profilePhotoUploads.userId, userId),
    ));
    return upload ?? null;
  }

  async claimUploadFinalization(userId: string, uploadId: string, now = new Date(), leaseMs = 30_000) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const [upload] = await tx.select().from(profilePhotoUploads).where(and(
        eq(profilePhotoUploads.id, uploadId),
        eq(profilePhotoUploads.userId, userId),
      )).for("update");
      if (!upload) throw new Error("UPLOAD_NOT_FOUND");
      if (upload.completedPhotoId) {
        return { state: "completed" as const, result: await this.readCompleted(tx, upload.completedPhotoId) };
      }
      if (upload.expiresAt <= now) throw new Error("UPLOAD_EXPIRED");
      if (upload.finalizationStatus === "processing"
        && upload.finalizationLeaseExpiresAt && upload.finalizationLeaseExpiresAt > now) {
        return { state: "busy" as const };
      }
      const leaseId = randomUUID();
      const finalObjectKey = upload.finalObjectKey
        ?? `profile-review/${userId}/${upload.id}.${extensionForMime[upload.mimeType]}`;
      const [claimed] = await tx.update(profilePhotoUploads).set({
        finalObjectKey,
        finalizationStatus: "processing",
        finalizationLeaseId: leaseId,
        finalizationLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        finalOrphanCleanupDueAt: upload.finalOrphanCleanupDueAt ?? upload.expiresAt,
        updatedAt: now,
      }).where(and(
        eq(profilePhotoUploads.id, upload.id),
        isNull(profilePhotoUploads.completedPhotoId),
      )).returning();
      if (!claimed) throw new Error("UPLOAD_FINALIZATION_CONFLICT");
      return { state: "claimed" as const, upload: claimed, leaseId };
    });
  }

  async bindUploadSourceEtag(uploadId: string, leaseId: string, etag: string, now = new Date()) {
    if (!etag) return false;
    const rows = await this.database.update(profilePhotoUploads).set({ sourceEtag: etag, updatedAt: now }).where(and(
      eq(profilePhotoUploads.id, uploadId),
      eq(profilePhotoUploads.finalizationStatus, "processing"),
      eq(profilePhotoUploads.finalizationLeaseId, leaseId),
      or(isNull(profilePhotoUploads.sourceEtag), eq(profilePhotoUploads.sourceEtag, etag)),
    )).returning({ id: profilePhotoUploads.id });
    return rows.length === 1;
  }

  async abandonUploadFinalization(uploadId: string, leaseId: string, now = new Date()) {
    const rows = await this.database.update(profilePhotoUploads).set({
      finalizationStatus: "pending",
      finalizationLeaseId: null,
      finalizationLeaseExpiresAt: null,
      updatedAt: now,
    }).where(and(
      eq(profilePhotoUploads.id, uploadId),
      eq(profilePhotoUploads.finalizationStatus, "processing"),
      eq(profilePhotoUploads.finalizationLeaseId, leaseId),
      isNull(profilePhotoUploads.completedPhotoId),
    )).returning({ id: profilePhotoUploads.id });
    return rows.length === 1;
  }

  async commitUploadFinalization(
    userId: string,
    uploadId: string,
    leaseId: string,
    finalized: { sizeBytes: number; mimeType: string; objectKey: string; etag?: string },
    now = new Date(),
  ) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const [upload] = await tx.select().from(profilePhotoUploads).where(and(
        eq(profilePhotoUploads.id, uploadId),
        eq(profilePhotoUploads.userId, userId),
      )).for("update");
      if (!upload) throw new Error("UPLOAD_NOT_FOUND");
      if (upload.completedPhotoId) return this.readCompleted(tx, upload.completedPhotoId);
      if (upload.finalizationStatus !== "processing" || upload.finalizationLeaseId !== leaseId
        || !upload.finalizationLeaseExpiresAt || upload.finalizationLeaseExpiresAt <= now) {
        throw new Error("UPLOAD_FINALIZATION_LEASE_LOST");
      }
      const expectedFinalKey = `profile-review/${userId}/${upload.id}.${extensionForMime[upload.mimeType]}`;
      if (upload.finalObjectKey !== expectedFinalKey || finalized.objectKey !== expectedFinalKey
        || finalized.mimeType !== upload.mimeType || finalized.sizeBytes !== upload.declaredSizeBytes) {
        throw new Error("INVALID_FINAL_MEDIA_KEY");
      }
      const [lockedProfile] = await tx.select({ id: profiles.id }).from(profiles)
        .where(and(eq(profiles.id, upload.profileId), eq(profiles.userId, userId))).for("update");
      if (!lockedProfile) throw new Error("PROFILE_REQUIRED");
      const [{ value: maximumPosition }] = await tx.select({ value: max(profilePhotos.position) })
        .from(profilePhotos).where(eq(profilePhotos.profileId, upload.profileId));
      const [photo] = await tx.insert(profilePhotos).values({
        userId,
        profileId: upload.profileId,
        uploadId: upload.id,
        objectKey: finalized.objectKey,
        position: (maximumPosition ?? -1) + 1,
        actualMimeType: finalized.mimeType,
        actualSizeBytes: finalized.sizeBytes,
        moderationStatus: "pending",
      }).returning();
      const [job] = await tx.insert(mediaReviewJobs).values({
        userId,
        photoId: photo.id,
        objectKey: finalized.objectKey,
        availableAt: now,
      }).returning();
      await tx.update(profilePhotoUploads).set({
        completedPhotoId: photo.id,
        finalizationStatus: "finalized",
        finalizationLeaseId: null,
        finalizationLeaseExpiresAt: null,
        stagingCleanupDueAt: now,
        finalOrphanCleanupDueAt: null,
        updatedAt: now,
      }).where(and(
        eq(profilePhotoUploads.id, upload.id),
        eq(profilePhotoUploads.finalizationLeaseId, leaseId),
      ));
      return { photo, job };
    });
  }

  async completeUpload(
    userId: string,
    uploadId: string,
    finalize: (upload: typeof profilePhotoUploads.$inferSelect) => Promise<{
      sizeBytes: number; mimeType: string; objectKey: string;
    }>,
  ) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const now = this.clock();
      const claim = await this.claimUploadFinalization(userId, uploadId, now, 30_000);
      if (claim.state === "completed") return claim.result;
      if (claim.state === "busy") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      let commitStarted = false;
      try {
        const finalized = await finalize(claim.upload);
        commitStarted = true;
        return await this.commitUploadFinalization(userId, uploadId, claim.leaseId, finalized, this.clock());
      } catch (error) {
        if (!commitStarted) {
          await this.abandonUploadFinalization(uploadId, claim.leaseId, this.clock());
        }
        throw error;
      }
    }
    throw new Error("UPLOAD_FINALIZATION_IN_PROGRESS");
  }

  async claimDue(now = new Date(), leaseMs = 30_000, batchSize = 10) {
    const candidates = await this.database.select().from(mediaReviewJobs).where(or(
      and(eq(mediaReviewJobs.status, "pending"), lte(mediaReviewJobs.availableAt, now)),
      and(eq(mediaReviewJobs.status, "processing"), lte(mediaReviewJobs.leaseExpiresAt, now)),
    )).orderBy(asc(mediaReviewJobs.availableAt)).limit(batchSize);
    const claimed: Array<typeof mediaReviewJobs.$inferSelect> = [];
    for (const candidate of candidates) {
      const leaseId = randomUUID();
      const [row] = await this.database.update(mediaReviewJobs).set({
        status: "processing",
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      }).where(and(
        eq(mediaReviewJobs.id, candidate.id),
        or(
          and(eq(mediaReviewJobs.status, "pending"), lte(mediaReviewJobs.availableAt, now)),
          and(eq(mediaReviewJobs.status, "processing"), lte(mediaReviewJobs.leaseExpiresAt, now)),
        ),
      )).returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }

  async renewLease(jobId: string, leaseId: string, now = new Date(), leaseMs = 30_000) {
    const renewed = await this.database.update(mediaReviewJobs).set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    }).where(and(
      eq(mediaReviewJobs.id, jobId),
      eq(mediaReviewJobs.leaseId, leaseId),
      eq(mediaReviewJobs.status, "processing"),
    )).returning({ id: mediaReviewJobs.id });
    return renewed.length === 1;
  }

  async completeReview(jobId: string, leaseId: string, result: ReviewOutcome, now = new Date(), rejectedRetentionMs = 7 * 86_400_000) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const [claimed] = await tx.select().from(mediaReviewJobs).where(and(
        eq(mediaReviewJobs.id, jobId),
        eq(mediaReviewJobs.leaseId, leaseId),
        eq(mediaReviewJobs.status, "processing"),
      )).for("update");
      if (!claimed) return false;
      const attempt = claimed.attempts + 1;
      await tx.insert(mediaReviewResults).values({
        jobId: claimed.id,
        photoId: claimed.photoId,
        attempt,
        provider: result.provider,
        providerVersion: result.version,
        outcome: result.outcome,
        reasonCode: result.outcome === "rejected" ? result.reasonCode ?? "MEDIA_REJECTED" : null,
        createdAt: now,
      });
      const [job] = await tx.update(mediaReviewJobs).set({
        status: "completed",
        attempts: attempt,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: now,
      }).where(and(
        eq(mediaReviewJobs.id, jobId),
        eq(mediaReviewJobs.leaseId, leaseId),
        eq(mediaReviewJobs.status, "processing"),
      )).returning();
      if (!job) throw new Error("MEDIA_REVIEW_LEASE_LOST");
      await tx.update(profilePhotos).set({
        moderationStatus: result.outcome,
        moderationReasonCode: result.outcome === "rejected" ? result.reasonCode ?? "MEDIA_REJECTED" : null,
        reviewProvider: result.provider,
        reviewVersion: result.version,
        width: result.width,
        height: result.height,
        reviewedAt: now,
        ...(result.outcome === "rejected"
          ? { cleanupDueAt: new Date(now.getTime() + rejectedRetentionMs) }
          : {}),
        updatedAt: now,
      }).where(and(eq(profilePhotos.id, job.photoId), eq(profilePhotos.moderationStatus, "pending")));
      if (result.outcome === "rejected") {
        await tx.update(profilePhotoUploads).set({ quotaSlot: null, updatedAt: now })
          .where(eq(profilePhotoUploads.completedPhotoId, job.photoId));
      }
      return true;
    });
  }

  async failReview(
    jobId: string,
    leaseId: string,
    now = new Date(),
    errorCode = "MEDIA_REVIEW_FAILED",
    maxAttempts = Number.MAX_SAFE_INTEGER,
  ) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const [job] = await tx.select().from(mediaReviewJobs).where(and(
        eq(mediaReviewJobs.id, jobId), eq(mediaReviewJobs.leaseId, leaseId), eq(mediaReviewJobs.status, "processing"),
      )).for("update");
      if (!job) return false;
      const attempts = job.attempts + 1;
      const terminal = attempts >= maxAttempts;
      if (terminal) {
        await tx.insert(mediaReviewResults).values({
          jobId: job.id,
          photoId: job.photoId,
          attempt: attempts,
          provider: "internal",
          providerVersion: "retry-v1",
          outcome: "rejected",
          reasonCode: "MEDIA_REVIEW_FAILED",
          createdAt: now,
        });
      }
      const [updated] = await tx.update(mediaReviewJobs).set({
        status: terminal ? "failed" : "pending",
        attempts,
        availableAt: new Date(now.getTime() + Math.min(3_600_000, 1_000 * (2 ** attempts))),
        leaseId: null,
        leaseExpiresAt: null,
        lastError: permittedErrors.has(errorCode) ? errorCode : "MEDIA_REVIEW_FAILED",
        updatedAt: now,
      }).where(and(
        eq(mediaReviewJobs.id, jobId), eq(mediaReviewJobs.leaseId, leaseId), eq(mediaReviewJobs.status, "processing"),
      )).returning({ id: mediaReviewJobs.id });
      if (!updated) return false;
      if (terminal) {
        await tx.update(profilePhotos).set({
          moderationStatus: "rejected",
          moderationReasonCode: "MEDIA_REVIEW_FAILED",
          reviewProvider: "internal",
          reviewVersion: "retry-v1",
          reviewedAt: now,
          cleanupDueAt: new Date(now.getTime() + 7 * 86_400_000),
          updatedAt: now,
        }).where(and(eq(profilePhotos.id, job.photoId), eq(profilePhotos.moderationStatus, "pending")));
        await tx.update(profilePhotoUploads).set({ quotaSlot: null, updatedAt: now })
          .where(eq(profilePhotoUploads.completedPhotoId, job.photoId));
      }
      return true;
    });
  }

  async getPhoto(photoId: string) {
    const [photo] = await this.database.select().from(profilePhotos).where(eq(profilePhotos.id, photoId));
    return photo ?? null;
  }

  async listPhotosForUser(userId: string) {
    return this.database.select().from(profilePhotos).where(and(
      eq(profilePhotos.userId, userId),
      isNull(profilePhotos.userRemovedAt),
    )).orderBy(asc(profilePhotos.position));
  }

  async markPhotoRemoved(userId: string, photoId: string) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const now = this.clock();
      const [ownedPhoto] = await tx.select({ profileId: profilePhotos.profileId }).from(profilePhotos).where(and(
        eq(profilePhotos.id, photoId),
        eq(profilePhotos.userId, userId),
        isNull(profilePhotos.userRemovedAt),
      ));
      if (!ownedPhoto) return false;
      // Serialize all removals for one profile so two different last photos cannot both
      // observe the other as still approved and accidentally leave the profile public.
      const [lockedProfile] = await tx.select({ id: profiles.id }).from(profiles)
        .where(eq(profiles.id, ownedPhoto.profileId)).for("update");
      if (!lockedProfile) return false;
      const [photo] = await tx.update(profilePhotos).set({
        userRemovedAt: now,
        cleanupDueAt: now,
        updatedAt: now,
      }).where(and(
        eq(profilePhotos.id, photoId),
        eq(profilePhotos.userId, userId),
        isNull(profilePhotos.userRemovedAt),
      )).returning({
        id: profilePhotos.id,
        profileId: profilePhotos.profileId,
        uploadId: profilePhotos.uploadId,
        moderationStatus: profilePhotos.moderationStatus,
      });
      if (!photo) return false;
      if (photo.uploadId) {
        await tx.update(profilePhotoUploads).set({ quotaSlot: null, updatedAt: now }).where(and(
          eq(profilePhotoUploads.id, photo.uploadId),
          eq(profilePhotoUploads.completedPhotoId, photo.id),
        ));
      }
      if (photo.moderationStatus === "approved") {
        const [{ value: remainingApproved }] = await tx.select({ value: count() }).from(profilePhotos).where(and(
          eq(profilePhotos.profileId, photo.profileId),
          eq(profilePhotos.moderationStatus, "approved"),
          isNull(profilePhotos.userRemovedAt),
        ));
        if (Number(remainingApproved) === 0) {
          await tx.update(profiles).set({
            status: "draft", discoverable: false, publishRequested: false, updatedAt: now,
          }).where(eq(profiles.id, photo.profileId));
        }
      }
      return true;
    });
  }

  async listCleanupDue(now = new Date(), limit = 20) {
    return this.database.select().from(profilePhotos).where(and(
      lte(profilePhotos.cleanupDueAt, now),
      isNull(profilePhotos.objectDeletedAt),
    )).limit(limit);
  }

  async markObjectDeleted(photoId: string, expectedObjectKey: string, now = new Date()) {
    const rows = await this.database.update(profilePhotos).set({ objectDeletedAt: now, updatedAt: now }).where(and(
      eq(profilePhotos.id, photoId), eq(profilePhotos.objectKey, expectedObjectKey), isNull(profilePhotos.objectDeletedAt),
    )).returning({ id: profilePhotos.id });
    return rows.length === 1;
  }

  async listUploadArtifactCleanupDue(now = new Date(), limit = 20) {
    const leaseInactive = or(
      ne(profilePhotoUploads.finalizationStatus, "processing"),
      isNull(profilePhotoUploads.finalizationLeaseExpiresAt),
      lte(profilePhotoUploads.finalizationLeaseExpiresAt, now),
    );
    return this.database.select().from(profilePhotoUploads).where(or(
      and(
        isNull(profilePhotoUploads.stagingDeletedAt),
        or(
          lte(profilePhotoUploads.stagingCleanupDueAt, now),
          and(lte(profilePhotoUploads.expiresAt, now), leaseInactive),
        ),
      ),
      and(
        isNull(profilePhotoUploads.completedPhotoId),
        isNotNull(profilePhotoUploads.finalObjectKey),
        isNull(profilePhotoUploads.finalOrphanDeletedAt),
        lte(profilePhotoUploads.finalOrphanCleanupDueAt, now),
        leaseInactive,
      ),
    )).limit(limit);
  }

  async claimUploadArtifactCleanup(uploadId: string, now = new Date(), leaseMs = 30_000) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const [upload] = await tx.select().from(profilePhotoUploads)
        .where(eq(profilePhotoUploads.id, uploadId)).for("update");
      if (!upload) return null;
      const activeCleanup = upload.artifactCleanupLeaseExpiresAt
        && upload.artifactCleanupLeaseExpiresAt > now;
      if (activeCleanup) return null;
      const activeFinalize = upload.finalizationStatus === "processing"
        && upload.finalizationLeaseExpiresAt && upload.finalizationLeaseExpiresAt > now;
      if (activeFinalize) return null;
      const deleteStagingObjectKey = !upload.stagingDeletedAt
        && ((upload.stagingCleanupDueAt && upload.stagingCleanupDueAt <= now) || upload.expiresAt <= now)
        ? upload.objectKey
        : null;
      const deleteFinalObjectKey = !upload.completedPhotoId && upload.finalObjectKey
        && !upload.finalOrphanDeletedAt && upload.finalOrphanCleanupDueAt
        && upload.finalOrphanCleanupDueAt <= now
        ? upload.finalObjectKey
        : null;
      if (!deleteStagingObjectKey && !deleteFinalObjectKey) return null;
      const leaseId = randomUUID();
      const [claimed] = await tx.update(profilePhotoUploads).set({
        artifactCleanupLeaseId: leaseId,
        artifactCleanupLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        ...(!upload.completedPhotoId ? {
          finalizationStatus: "cleanup",
          finalizationLeaseId: null,
          finalizationLeaseExpiresAt: null,
        } : {}),
        updatedAt: now,
      }).where(eq(profilePhotoUploads.id, upload.id)).returning();
      if (!claimed) return null;
      return { leaseId, deleteStagingObjectKey, deleteFinalObjectKey };
    });
  }

  async markStagingDeleted(uploadId: string, leaseId: string, expectedObjectKey: string, now = new Date()) {
    const rows = await this.database.update(profilePhotoUploads).set({
      stagingDeletedAt: now,
      updatedAt: now,
    }).where(and(
      eq(profilePhotoUploads.id, uploadId),
      eq(profilePhotoUploads.artifactCleanupLeaseId, leaseId),
      eq(profilePhotoUploads.objectKey, expectedObjectKey),
      isNull(profilePhotoUploads.stagingDeletedAt),
    )).returning({ id: profilePhotoUploads.id });
    return rows.length === 1;
  }

  async markFinalOrphanDeleted(uploadId: string, leaseId: string, expectedObjectKey: string, now = new Date()) {
    const rows = await this.database.update(profilePhotoUploads).set({
      finalOrphanDeletedAt: now,
      updatedAt: now,
    }).where(and(
      eq(profilePhotoUploads.id, uploadId),
      eq(profilePhotoUploads.artifactCleanupLeaseId, leaseId),
      eq(profilePhotoUploads.finalObjectKey, expectedObjectKey),
      eq(profilePhotoUploads.finalizationStatus, "cleanup"),
      isNull(profilePhotoUploads.completedPhotoId),
      isNull(profilePhotoUploads.finalOrphanDeletedAt),
    )).returning({ id: profilePhotoUploads.id });
    return rows.length === 1;
  }

  async releaseUploadArtifactCleanup(uploadId: string, leaseId: string, now = new Date()) {
    const rows = await this.database.update(profilePhotoUploads).set({
      artifactCleanupLeaseId: null,
      artifactCleanupLeaseExpiresAt: null,
      updatedAt: now,
    }).where(and(
      eq(profilePhotoUploads.id, uploadId),
      eq(profilePhotoUploads.artifactCleanupLeaseId, leaseId),
    )).returning({ id: profilePhotoUploads.id });
    return rows.length === 1;
  }

  private async readCompleted(database: MediaDatabase, photoId: string) {
    const [photo] = await database.select().from(profilePhotos).where(eq(profilePhotos.id, photoId));
    const [job] = await database.select().from(mediaReviewJobs).where(eq(mediaReviewJobs.photoId, photoId));
    if (!photo || !job) throw new Error("MEDIA_COMPLETION_INCONSISTENT");
    return { photo, job };
  }
}
