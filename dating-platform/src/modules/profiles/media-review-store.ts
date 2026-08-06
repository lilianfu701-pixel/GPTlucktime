import { randomUUID } from "node:crypto";

import { and, asc, count, eq, isNull, lte, max, or, sql } from "drizzle-orm";

import {
  mediaReviewJobs,
  profilePhotoUploads,
  profilePhotos,
  profiles,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import type { PhotoMediaStore, ReservedUpload } from "./media-service";

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

export class MediaReviewStore implements PhotoMediaStore {
  readonly database: MediaDatabase;
  private readonly maximumPhotos: number;
  private readonly clock: () => Date;

  constructor(database: unknown, options: { maximumPhotos?: number; clock?: () => Date } = {}) {
    this.database = database as MediaDatabase;
    this.maximumPhotos = options.maximumPhotos ?? 6;
    this.clock = options.clock ?? (() => new Date());
  }

  async reserveUpload(input: Omit<ReservedUpload, "id" | "profileId" | "completedPhotoId">) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const [existing] = await tx.select().from(profilePhotoUploads).where(and(
        eq(profilePhotoUploads.userId, input.userId),
        eq(profilePhotoUploads.idempotencyHash, input.idempotencyHash),
      ));
      if (existing) return existing;
      const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, input.userId)).for("update");
      if (!profile) throw new Error("PROFILE_REQUIRED");
      const [{ value: photoCount }] = await tx.select({ value: count() }).from(profilePhotos)
        .where(eq(profilePhotos.userId, input.userId));
      const [{ value: reservedCount }] = await tx.select({ value: count() }).from(profilePhotoUploads).where(and(
        eq(profilePhotoUploads.userId, input.userId),
        isNull(profilePhotoUploads.completedPhotoId),
        sql`${profilePhotoUploads.expiresAt} > now()`,
      ));
      if (Number(photoCount) + Number(reservedCount) >= this.maximumPhotos) {
        throw new Error("PHOTO_QUOTA_EXCEEDED");
      }
      const [created] = await tx.insert(profilePhotoUploads).values({
        ...input,
        profileId: profile.id,
      }).returning();
      return created;
    });
  }

  async findUpload(userId: string, uploadId: string) {
    const [upload] = await this.database.select().from(profilePhotoUploads).where(and(
      eq(profilePhotoUploads.id, uploadId),
      eq(profilePhotoUploads.userId, userId),
    ));
    return upload ?? null;
  }

  async completeUpload(userId: string, uploadId: string, metadata: { sizeBytes: number; mimeType: string }) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as MediaDatabase;
      const [upload] = await tx.select().from(profilePhotoUploads).where(and(
        eq(profilePhotoUploads.id, uploadId),
        eq(profilePhotoUploads.userId, userId),
      )).for("update");
      if (!upload) throw new Error("UPLOAD_NOT_FOUND");
      if (upload.completedPhotoId) return this.readCompleted(tx, upload.completedPhotoId);
      const [lockedProfile] = await tx.select({ id: profiles.id }).from(profiles)
        .where(and(eq(profiles.id, upload.profileId), eq(profiles.userId, userId))).for("update");
      if (!lockedProfile) throw new Error("PROFILE_REQUIRED");
      const [{ value: maximumPosition }] = await tx.select({ value: max(profilePhotos.position) })
        .from(profilePhotos).where(eq(profilePhotos.profileId, upload.profileId));
      const [photo] = await tx.insert(profilePhotos).values({
        userId,
        profileId: upload.profileId,
        uploadId: upload.id,
        objectKey: upload.objectKey,
        position: (maximumPosition ?? -1) + 1,
        actualMimeType: metadata.mimeType,
        actualSizeBytes: metadata.sizeBytes,
        moderationStatus: "pending",
      }).returning();
      const [job] = await tx.insert(mediaReviewJobs).values({
        userId,
        photoId: photo.id,
        objectKey: upload.objectKey,
        availableAt: this.clock(),
      }).returning();
      await tx.update(profilePhotoUploads).set({ completedPhotoId: photo.id, updatedAt: this.clock() })
        .where(eq(profilePhotoUploads.id, upload.id));
      return { photo, job };
    });
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
      const [job] = await tx.update(mediaReviewJobs).set({
        status: "completed",
        attempts: sql`${mediaReviewJobs.attempts} + 1`,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: now,
      }).where(and(
        eq(mediaReviewJobs.id, jobId),
        eq(mediaReviewJobs.leaseId, leaseId),
        eq(mediaReviewJobs.status, "processing"),
      )).returning();
      if (!job) return false;
      await tx.update(profilePhotos).set({
        moderationStatus: result.outcome,
        moderationReasonCode: result.outcome === "rejected" ? result.reasonCode ?? "MEDIA_REJECTED" : null,
        reviewProvider: result.provider,
        reviewVersion: result.version,
        width: result.width,
        height: result.height,
        reviewedAt: now,
        cleanupDueAt: result.outcome === "rejected" ? new Date(now.getTime() + rejectedRetentionMs) : null,
        updatedAt: now,
      }).where(and(eq(profilePhotos.id, job.photoId), eq(profilePhotos.moderationStatus, "pending")));
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
    const [job] = await this.database.select().from(mediaReviewJobs).where(and(
      eq(mediaReviewJobs.id, jobId), eq(mediaReviewJobs.leaseId, leaseId), eq(mediaReviewJobs.status, "processing"),
    ));
    if (!job) return false;
    const attempts = job.attempts + 1;
    const updated = await this.database.update(mediaReviewJobs).set({
      status: attempts >= maxAttempts ? "failed" : "pending",
      attempts,
      availableAt: new Date(now.getTime() + Math.min(3_600_000, 1_000 * (2 ** attempts))),
      leaseId: null,
      leaseExpiresAt: null,
      lastError: permittedErrors.has(errorCode) ? errorCode : "MEDIA_REVIEW_FAILED",
      updatedAt: now,
    }).where(and(
      eq(mediaReviewJobs.id, jobId), eq(mediaReviewJobs.leaseId, leaseId), eq(mediaReviewJobs.status, "processing"),
    )).returning({ id: mediaReviewJobs.id });
    return updated.length === 1;
  }

  async getPhoto(photoId: string) {
    const [photo] = await this.database.select().from(profilePhotos).where(eq(profilePhotos.id, photoId));
    return photo ?? null;
  }

  async listCleanupDue(now = new Date(), limit = 20) {
    return this.database.select().from(profilePhotos).where(and(
      eq(profilePhotos.moderationStatus, "rejected"),
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

  private async readCompleted(database: MediaDatabase, photoId: string) {
    const [photo] = await database.select().from(profilePhotos).where(eq(profilePhotos.id, photoId));
    const [job] = await database.select().from(mediaReviewJobs).where(eq(mediaReviewJobs.photoId, photoId));
    if (!photo || !job) throw new Error("MEDIA_COMPLETION_INCONSISTENT");
    return { photo, job };
  }
}
