import { randomUUID } from "node:crypto";

import { and, asc, eq, lte, or } from "drizzle-orm";

import {
  mediaPreservationTasks,
  moderationMediaCopies,
  moderationMediaHolds,
  profilePhotos,
  users,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import type { StorageAdapter } from "@/modules/profiles/media-service";

import type { ImmutableMediaSource } from "./media-hold-policy";
import { mediaHoldSnapshotSha256 } from "./media-hold-integrity";

type ModerationDatabase = typeof productionDatabase;

export type PreservedMediaObject = {
  objectKey: string;
  objectVersion: string;
  objectEtag: string;
};

export interface MediaEvidencePreserver {
  preserve(
    source: ImmutableMediaSource,
    destinationObjectKey: string,
  ): Promise<PreservedMediaObject>;
}

export const unavailableMediaEvidencePreserver: MediaEvidencePreserver = {
  preserve: async () => { throw new Error("MEDIA_EVIDENCE_STORAGE_NOT_CONFIGURED"); },
};

export class StorageMediaEvidencePreserver implements MediaEvidencePreserver {
  constructor(private readonly storage: Pick<StorageAdapter, "copyObject" | "headObject"> | null) {}

  async preserve(source: ImmutableMediaSource, destinationObjectKey: string) {
    if (!this.storage) throw new Error("MEDIA_EVIDENCE_STORAGE_NOT_CONFIGURED");
    await this.storage.copyObject(source.objectKey, destinationObjectKey, {
      sourceETag: source.objectEtag,
      sourceVersionId: source.objectVersion,
    });
    const copied = await this.storage.headObject(destinationObjectKey);
    if (!copied?.versionId || !copied.etag) throw new Error("MEDIA_EVIDENCE_COPY_NOT_AVAILABLE");
    return {
      objectKey: destinationObjectKey,
      objectVersion: copied.versionId,
      objectEtag: copied.etag,
    };
  }
}

export async function preserveLegacyMediaTasks(input: {
  database: ModerationDatabase;
  storage: Pick<StorageAdapter, "copyObject" | "headObject">;
  clock?: () => Date;
  batchSize?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  maxAttempts?: number;
}) {
  let completed = 0;
  const batchSize = Math.max(1, Math.min(50, input.batchSize ?? 10));
  const leaseMs = input.leaseMs ?? 60_000;
  const retryBaseMs = input.retryBaseMs ?? 30_000;
  const maxAttempts = input.maxAttempts ?? 5;
  for (let index = 0; index < batchSize; index += 1) {
    const claimNow = input.clock?.() ?? new Date();
    const claim = await input.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ModerationDatabase;
      const [task] = await tx.select().from(mediaPreservationTasks).where(or(
        and(
          eq(mediaPreservationTasks.status, "pending"),
          lte(mediaPreservationTasks.updatedAt, claimNow),
        ),
        and(
          eq(mediaPreservationTasks.status, "processing"),
          lte(mediaPreservationTasks.leaseExpiresAt, claimNow),
        ),
      )).orderBy(asc(mediaPreservationTasks.createdAt), asc(mediaPreservationTasks.id))
        .for("update", { skipLocked: true }).limit(1);
      if (!task) return false;
      const leaseId = randomUUID();
      const [claimed] = await tx.update(mediaPreservationTasks).set({
        status: "processing",
        leaseId,
        leaseExpiresAt: new Date(claimNow.getTime() + leaseMs),
        attempts: task.attempts + 1,
        updatedAt: claimNow,
      }).where(eq(mediaPreservationTasks.id, task.id)).returning();
      return claimed ?? false;
    });
    if (!claim) break;
    try {
      const done = await input.database.transaction(async (transaction) => {
        const tx = transaction as unknown as ModerationDatabase;
        const [task] = await tx.select().from(mediaPreservationTasks).where(and(
          eq(mediaPreservationTasks.id, claim.id),
          eq(mediaPreservationTasks.status, "processing"),
          eq(mediaPreservationTasks.leaseId, claim.leaseId!),
        )).for("update").limit(1);
        if (!task) return false;
      await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, task.subjectUserId)).for("update").limit(1);
      const [photo] = await tx.select().from(profilePhotos).where(and(
        eq(profilePhotos.id, task.photoId),
        eq(profilePhotos.userId, task.subjectUserId),
        eq(profilePhotos.objectKey, task.sourceObjectKey),
      )).for("update").limit(1);
      if (!photo || !["legacy_unversioned", "preservation_pending"].includes(photo.preservationStatus)
        || photo.objectDeletedAt) throw new Error("LEGACY_MEDIA_RELATION_INVALID");
      const now = input.clock?.() ?? new Date();
      const source = await input.storage.headObject(photo.objectKey);
      if (!source?.versionId || !source.etag) throw new Error("LEGACY_MEDIA_SOURCE_NOT_AVAILABLE");
      await input.storage.copyObject(photo.objectKey, task.destinationObjectKey, {
        sourceETag: source.etag,
        sourceVersionId: source.versionId,
      });
      const copied = await input.storage.headObject(task.destinationObjectKey);
      if (!copied?.versionId || !copied.etag) throw new Error("MEDIA_EVIDENCE_COPY_NOT_AVAILABLE");
      const [evidenceCopy] = await tx.insert(moderationMediaCopies).values({
        reportId: task.reportId,
        caseId: task.caseId,
        subjectUserId: task.subjectUserId,
        photoId: task.photoId,
        sourceObjectKey: task.sourceObjectKey,
        sourceObjectVersion: source.versionId,
        sourceObjectEtag: source.etag,
        captureMode: "current_object_etag",
        objectKey: task.destinationObjectKey,
        objectVersion: copied.versionId,
        objectEtag: copied.etag,
        createdAt: now,
      }).returning();
      const preserveUntil = new Date(Date.UTC(now.getUTCFullYear() + 7, now.getUTCMonth(), now.getUTCDate()));
      await tx.insert(moderationMediaHolds).values({
        reportId: task.reportId,
        caseId: task.caseId,
        subjectUserId: task.subjectUserId,
        photoId: task.photoId,
        evidenceCopyId: evidenceCopy.id,
        objectKey: evidenceCopy.objectKey,
        objectVersion: evidenceCopy.objectVersion,
        snapshotSha256: mediaHoldSnapshotSha256({
          reportId: task.reportId,
          caseId: task.caseId,
          subjectUserId: task.subjectUserId,
          photoId: task.photoId,
          objectKey: evidenceCopy.objectKey,
          objectVersion: evidenceCopy.objectVersion,
          preserveUntil,
        }),
        preserveUntil,
        createdAt: now,
      });
      await tx.update(profilePhotos).set({ preservationStatus: "legacy_preserved", updatedAt: now })
        .where(eq(profilePhotos.id, task.photoId));
      await tx.update(mediaPreservationTasks).set({
        status: "completed",
        leaseId: null,
        leaseExpiresAt: null,
        evidenceCopyId: evidenceCopy.id,
        lastError: null,
        updatedAt: now,
        completedAt: now,
      }).where(and(
        eq(mediaPreservationTasks.id, task.id),
        eq(mediaPreservationTasks.leaseId, task.leaseId!),
      ));
      return true;
      });
      if (done) completed += 1;
    } catch (error) {
      const now = input.clock?.() ?? new Date();
      const message = error instanceof Error ? error.message : "";
      const permanent = message.startsWith("STORAGE_ACCESS_DENIED")
        || message === "STORAGE_VERSIONING_REQUIRED"
        || message === "LEGACY_MEDIA_RELATION_INVALID";
      const terminal = permanent || claim.attempts >= maxAttempts;
      await input.database.update(mediaPreservationTasks).set({
        status: terminal ? "manual_review" : "pending",
        leaseId: null,
        leaseExpiresAt: null,
        lastError: terminal ? "LEGACY_MEDIA_MANUAL_REVIEW" : "LEGACY_MEDIA_STORAGE_RETRY",
        updatedAt: terminal
          ? now
          : new Date(now.getTime() + retryBaseMs * 2 ** Math.max(0, claim.attempts - 1)),
      }).where(and(
        eq(mediaPreservationTasks.id, claim.id),
        eq(mediaPreservationTasks.status, "processing"),
        eq(mediaPreservationTasks.leaseId, claim.leaseId!),
      ));
    }
  }
  return completed;
}
