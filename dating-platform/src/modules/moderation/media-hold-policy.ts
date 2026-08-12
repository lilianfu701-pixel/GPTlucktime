import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, lte } from "drizzle-orm";

import { moderationMediaHolds, profilePhotos, users } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type ModerationDatabase = typeof productionDatabase;

export type MediaDeletionClaim = {
  photoId: string;
  subjectUserId: string;
  objectKey: string;
  objectVersion: string;
  objectEtag: string;
  leaseId: string;
};

export type ImmutableMediaSource = Omit<MediaDeletionClaim, "leaseId">;

export interface MediaLegalHoldPolicy {
  prepareHoldInTransaction(
    transaction: unknown,
    input: { photoId: string; subjectUserId: string },
  ): Promise<ImmutableMediaSource | null>;
  claimDeletion(photoId: string, expectedObjectKey: string, now: Date): Promise<MediaDeletionClaim | null>;
  validateDeletionClaim(claim: MediaDeletionClaim, now: Date): Promise<boolean>;
  finalizeDeletionClaim(claim: MediaDeletionClaim, now: Date): Promise<boolean>;
  abortDeletionClaim(claim: MediaDeletionClaim): Promise<void>;
}

export class DrizzleMediaLegalHoldPolicy implements MediaLegalHoldPolicy {
  constructor(private readonly database: ModerationDatabase, private readonly deletionLeaseMs = 60_000) {}

  async prepareHoldInTransaction(
    transaction: unknown,
    input: { photoId: string; subjectUserId: string },
  ) {
    const tx = transaction as ModerationDatabase;
    await tx.select({ id: users.id }).from(users)
      .where(eq(users.id, input.subjectUserId)).for("update").limit(1);
    const [photo] = await tx.select().from(profilePhotos).where(and(
      eq(profilePhotos.id, input.photoId),
      eq(profilePhotos.userId, input.subjectUserId),
    )).for("update").limit(1);
    if (!photo || !photo.objectVersion || !photo.objectEtag) return null;
    if (photo.objectDeletedAt && photo.deletionStatus !== "deleting") return null;
    if (photo.deletionStatus === "claimed") {
      await tx.update(profilePhotos).set({
        deletionStatus: "idle",
        deletionLeaseId: null,
        deletionLeaseExpiresAt: null,
      }).where(and(eq(profilePhotos.id, photo.id), eq(profilePhotos.deletionStatus, "claimed")));
    }
    return {
      photoId: photo.id,
      subjectUserId: photo.userId,
      objectKey: photo.objectKey,
      objectVersion: photo.objectVersion,
      objectEtag: photo.objectEtag,
    };
  }

  async claimDeletion(photoId: string, expectedObjectKey: string, now: Date) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const [identity] = await tx.select({ subjectUserId: profilePhotos.userId }).from(profilePhotos)
        .where(and(eq(profilePhotos.id, photoId), eq(profilePhotos.objectKey, expectedObjectKey))).limit(1);
      if (!identity) return null;
      await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, identity.subjectUserId)).for("update").limit(1);
      const [photo] = await tx.select().from(profilePhotos).where(and(
        eq(profilePhotos.id, photoId),
        eq(profilePhotos.objectKey, expectedObjectKey),
      )).for("update").limit(1);
      if (!photo || photo.objectDeletedAt || !photo.objectVersion || !photo.objectEtag || !photo.cleanupDueAt
        || photo.cleanupDueAt > now || photo.deletionStatus === "deleting"
        || (photo.deletionStatus === "claimed" && photo.deletionLeaseExpiresAt && photo.deletionLeaseExpiresAt > now)) {
        return null;
      }
      const [hold] = await tx.select({ id: moderationMediaHolds.id }).from(moderationMediaHolds).where(and(
        eq(moderationMediaHolds.photoId, photo.id),
        eq(moderationMediaHolds.active, true),
      )).limit(1);
      if (hold) return null;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + this.deletionLeaseMs);
      const [claimed] = await tx.update(profilePhotos).set({
        deletionStatus: "claimed",
        deletionLeaseId: leaseId,
        deletionLeaseExpiresAt: leaseExpiresAt,
      }).where(and(eq(profilePhotos.id, photo.id), isNull(profilePhotos.objectDeletedAt))).returning();
      if (!claimed) return null;
      return {
        photoId: claimed.id,
        subjectUserId: claimed.userId,
        objectKey: claimed.objectKey,
        objectVersion: claimed.objectVersion!,
        objectEtag: claimed.objectEtag!,
        leaseId,
      };
    });
  }

  async validateDeletionClaim(claim: MediaDeletionClaim, now: Date) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, claim.subjectUserId)).for("update").limit(1);
      const [photo] = await tx.select().from(profilePhotos).where(and(
        eq(profilePhotos.id, claim.photoId),
        eq(profilePhotos.userId, claim.subjectUserId),
        eq(profilePhotos.objectKey, claim.objectKey),
        eq(profilePhotos.objectVersion, claim.objectVersion),
        eq(profilePhotos.objectEtag, claim.objectEtag),
        eq(profilePhotos.deletionStatus, "claimed"),
        eq(profilePhotos.deletionLeaseId, claim.leaseId),
        gt(profilePhotos.deletionLeaseExpiresAt, now),
        isNull(profilePhotos.objectDeletedAt),
      )).for("update").limit(1);
      if (!photo) return false;
      const [hold] = await tx.select({ id: moderationMediaHolds.id }).from(moderationMediaHolds).where(and(
        eq(moderationMediaHolds.photoId, claim.photoId),
        eq(moderationMediaHolds.active, true),
      )).limit(1);
      if (hold) return false;
      const updated = await tx.update(profilePhotos).set({ deletionStatus: "deleting" }).where(and(
        eq(profilePhotos.id, claim.photoId),
        eq(profilePhotos.deletionStatus, "claimed"),
        eq(profilePhotos.deletionLeaseId, claim.leaseId),
      )).returning({ id: profilePhotos.id });
      return updated.length === 1;
    });
  }

  async finalizeDeletionClaim(claim: MediaDeletionClaim, now: Date) {
    const rows = await this.database.update(profilePhotos).set({
      objectDeletedAt: now,
      updatedAt: now,
      deletionStatus: "idle",
      deletionLeaseId: null,
      deletionLeaseExpiresAt: null,
    }).where(and(
      eq(profilePhotos.id, claim.photoId),
      eq(profilePhotos.userId, claim.subjectUserId),
      eq(profilePhotos.objectKey, claim.objectKey),
      eq(profilePhotos.objectVersion, claim.objectVersion),
      eq(profilePhotos.objectEtag, claim.objectEtag),
      eq(profilePhotos.deletionStatus, "deleting"),
      eq(profilePhotos.deletionLeaseId, claim.leaseId),
      isNull(profilePhotos.objectDeletedAt),
    )).returning({ id: profilePhotos.id });
    return rows.length === 1;
  }

  async abortDeletionClaim(claim: MediaDeletionClaim) {
    await this.database.update(profilePhotos).set({
      deletionStatus: "idle",
      deletionLeaseId: null,
      deletionLeaseExpiresAt: null,
    }).where(and(
      eq(profilePhotos.id, claim.photoId),
      eq(profilePhotos.deletionLeaseId, claim.leaseId),
      lte(profilePhotos.deletionLeaseExpiresAt, new Date("9999-12-31T23:59:59.000Z")),
    ));
  }
}
