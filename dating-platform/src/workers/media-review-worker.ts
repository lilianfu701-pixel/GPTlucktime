import type { MediaReviewAdapter } from "@/modules/profiles/media-review-adapter";
import {
  HttpsMediaReviewAdapter,
  MediaReviewRetryableError,
} from "@/modules/profiles/media-review-adapter";
import type { MediaReviewStore } from "@/modules/profiles/media-review-store";
import { isOwnedReviewKey, type StorageAdapter } from "@/modules/profiles/media-service";
import { getProfileSharp, type ProfileImageMetadata } from "@/modules/profiles/sharp-runtime";

const sharpFormatToMime: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function inspectImage(
  bytes: Uint8Array,
  declaredMimeType: string,
  maximumPixels = 40_000_000,
) {
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("IMAGE_SIZE_EXCEEDED");
  let metadata: ProfileImageMetadata;
  try {
    metadata = await getProfileSharp()(bytes, {
      limitInputPixels: maximumPixels,
      failOn: "warning",
      animated: false,
      pages: 1,
    }).metadata();
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new Error("IMAGE_DIMENSIONS_EXCEEDED");
    }
    throw new Error("IMAGE_METADATA_INVALID");
  }
  const detectedMimeType = metadata.format ? sharpFormatToMime[metadata.format] : undefined;
  if (detectedMimeType !== declaredMimeType) throw new Error("SIGNATURE_MIME_MISMATCH");
  if (!metadata.width || !metadata.height) throw new Error("IMAGE_DIMENSIONS_INVALID");
  if ((metadata.pages ?? 1) !== 1 || metadata.pageHeight && metadata.pageHeight !== metadata.height) {
    throw new Error("ANIMATED_IMAGE_UNSUPPORTED");
  }
  if (metadata.width > 12_000 || metadata.height > 12_000
    || metadata.width * metadata.height > maximumPixels) {
    throw new Error("IMAGE_DIMENSIONS_EXCEEDED");
  }
  return { width: metadata.width, height: metadata.height };
}

export async function processMediaReviewJobs(input: {
  store: MediaReviewStore;
  storage: StorageAdapter;
  adapter: MediaReviewAdapter;
  clock?: () => Date;
  leaseMs?: number;
  batchSize?: number;
  rejectedRetentionMs?: number;
}) {
  const clock = input.clock ?? (() => new Date());
  const leaseMs = input.leaseMs ?? 30_000;
  const jobs = await input.store.claimDue(clock(), leaseMs, input.batchSize ?? 10);
  for (const job of jobs) {
    if (!job.leaseId) continue;
    const photo = await input.store.getPhoto(job.photoId);
    if (!photo || !photo.actualMimeType || !photo.actualSizeBytes
      || !isOwnedReviewKey(job.objectKey, job.userId) || photo.objectKey !== job.objectKey) {
      await input.store.completeReview(job.id, job.leaseId, {
        outcome: "rejected", provider: "internal", version: "headers-v1",
        reasonCode: "INVALID_MEDIA_KEY", width: 0, height: 0,
      }, clock(), input.rejectedRetentionMs);
      continue;
    }
    try {
      const maximumReviewBytes = 10 * 1024 * 1024;
      if (photo.actualSizeBytes > maximumReviewBytes) {
        await input.store.completeReview(job.id, job.leaseId, {
          outcome: "rejected", provider: "internal", version: "headers-v1",
          reasonCode: "OBJECT_SIZE_EXCEEDED", width: 0, height: 0,
        }, clock(), input.rejectedRetentionMs);
        continue;
      }
      const bytes = await input.storage.readPrefix(job.objectKey, photo.actualSizeBytes + 1);
      if (bytes.byteLength !== photo.actualSizeBytes) {
        await input.store.completeReview(job.id, job.leaseId, {
          outcome: "rejected", provider: "internal", version: "headers-v1",
          reasonCode: "OBJECT_SIZE_MISMATCH", width: 0, height: 0,
        }, clock(), input.rejectedRetentionMs);
        continue;
      }
      let dimensions: { width: number; height: number };
      try {
        dimensions = await inspectImage(bytes, photo.actualMimeType);
      } catch (error) {
        const reasonCode = error instanceof Error && [
          "SIGNATURE_MIME_MISMATCH", "IMAGE_METADATA_INVALID", "IMAGE_DIMENSIONS_INVALID",
          "IMAGE_DIMENSIONS_EXCEEDED", "ANIMATED_IMAGE_UNSUPPORTED", "IMAGE_SIZE_EXCEEDED",
        ].includes(error.message) ? error.message : "INVALID_IMAGE";
        await input.store.completeReview(job.id, job.leaseId, {
          outcome: "rejected", provider: "internal", version: "headers-v1", reasonCode,
          width: 0, height: 0,
        }, clock(), input.rejectedRetentionMs);
        continue;
      }
      if (!await input.store.renewLease(job.id, job.leaseId, clock(), leaseMs)) continue;
      const decision = await input.adapter.review({
        objectKey: job.objectKey,
        mimeType: photo.actualMimeType,
        bytes,
        ...dimensions,
      });
      await input.store.completeReview(job.id, job.leaseId, {
        ...decision,
        ...dimensions,
      }, clock(), input.rejectedRetentionMs);
    } catch (error) {
      await input.store.failReview(
        job.id,
        job.leaseId,
        clock(),
        error instanceof MediaReviewRetryableError ? "MEDIA_REVIEW_PROVIDER_RETRY" : "MEDIA_REVIEW_STORAGE_RETRY",
      );
    }
  }
  return jobs.length;
}

export async function cleanupRejectedMedia(input: {
  store: MediaReviewStore;
  storage: StorageAdapter;
  clock?: () => Date;
  batchSize?: number;
}) {
  const now = input.clock?.() ?? new Date();
  const photos = await input.store.listCleanupDue(now, input.batchSize ?? 20);
  let deleted = 0;
  for (const photo of photos) {
    try {
      await input.storage.deleteObject(photo.objectKey);
      if (await input.store.markObjectDeleted(photo.id, photo.objectKey, now)) deleted += 1;
    } catch {
      // A later cleanup pass retries; provider/storage details are intentionally not persisted here.
    }
  }
  return deleted;
}

export async function drainMediaWorkers(input: {
  store: MediaReviewStore;
  storage: StorageAdapter;
  adapter: MediaReviewAdapter;
  clock?: () => Date;
  leaseMs?: number;
  batchSize?: number;
  rejectedRetentionMs?: number;
}) {
  const reviewed = await processMediaReviewJobs(input);
  const deleted = await cleanupRejectedMedia({
    store: input.store,
    storage: input.storage,
    clock: input.clock,
    batchSize: input.batchSize,
  });
  return { reviewed, deleted };
}

export async function runConfiguredMediaReviewWorker() {
  const [{ profileMediaStorage, profileMediaStore }, { readEnv }] = await Promise.all([
    import("@/modules/profiles/media-runtime"),
    import("@/shared/env"),
  ]);
  if (!profileMediaStorage) return 0;
  const env = readEnv(process.env);
  const adapter = new HttpsMediaReviewAdapter(
    env.MEDIA_REVIEW_URL && env.MEDIA_REVIEW_API_KEY
      && env.MEDIA_REVIEW_PROVIDER && env.MEDIA_REVIEW_VERSION && env.MEDIA_REVIEW_ALLOWED_ORIGINS
      ? {
          endpoint: env.MEDIA_REVIEW_URL,
          apiKey: env.MEDIA_REVIEW_API_KEY,
          provider: env.MEDIA_REVIEW_PROVIDER,
          version: env.MEDIA_REVIEW_VERSION,
          allowedOrigins: env.MEDIA_REVIEW_ALLOWED_ORIGINS.split(","),
        }
      : undefined,
  );
  return drainMediaWorkers({
    store: profileMediaStore,
    storage: profileMediaStorage,
    adapter,
    rejectedRetentionMs: (env.MEDIA_REVIEW_REJECTED_RETENTION_HOURS ?? 168) * 3_600_000,
  });
}
