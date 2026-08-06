import type { MediaReviewAdapter } from "@/modules/profiles/media-review-adapter";
import {
  HttpsMediaReviewAdapter,
  MediaReviewRetryableError,
} from "@/modules/profiles/media-review-adapter";
import type { MediaReviewStore } from "@/modules/profiles/media-review-store";
import { isOwnedMediaKey, type StorageAdapter } from "@/modules/profiles/media-service";

const byteString = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.slice(start, start + length));

export function inspectImage(bytes: Uint8Array, declaredMimeType: string, maximumPixels = 40_000_000) {
  let width = 0;
  let height = 0;
  let detectedMime = "";
  if (bytes.length >= 24 && byteString(bytes, 0, 8) === "\u0089PNG\r\n\u001a\n") {
    detectedMime = "image/png";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 30 && byteString(bytes, 0, 4) === "RIFF" && byteString(bytes, 8, 4) === "WEBP") {
    detectedMime = "image/webp";
    const chunk = byteString(bytes, 12, 4);
    if (chunk === "VP8X") {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (chunk === "VP8 ") {
      width = (bytes[26]! | bytes[27]! << 8) & 0x3fff;
      height = (bytes[28]! | bytes[29]! << 8) & 0x3fff;
    } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes[21]! | bytes[22]! << 8 | bytes[23]! << 16 | bytes[24]! << 24;
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    detectedMime = "image/jpeg";
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd9 || marker === 0xda) break;
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
        break;
      }
      offset += 2 + length;
    }
  }
  if (!detectedMime || detectedMime !== declaredMimeType) throw new Error("SIGNATURE_MIME_MISMATCH");
  if (!width || !height) throw new Error("IMAGE_DIMENSIONS_INVALID");
  if (width > 12_000 || height > 12_000 || width * height > maximumPixels) {
    throw new Error("IMAGE_DIMENSIONS_EXCEEDED");
  }
  return { width, height };
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
      || !isOwnedMediaKey(job.objectKey, job.userId) || photo.objectKey !== job.objectKey) {
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
        dimensions = inspectImage(bytes.slice(0, 256 * 1024), photo.actualMimeType);
      } catch (error) {
        const reasonCode = error instanceof Error && [
          "SIGNATURE_MIME_MISMATCH", "IMAGE_DIMENSIONS_INVALID", "IMAGE_DIMENSIONS_EXCEEDED",
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

export async function runConfiguredMediaReviewWorker() {
  const [{ profileMediaStorage, profileMediaStore }, { readEnv }] = await Promise.all([
    import("@/modules/profiles/media-runtime"),
    import("@/shared/env"),
  ]);
  if (!profileMediaStorage) return 0;
  const env = readEnv(process.env);
  const adapter = new HttpsMediaReviewAdapter(
    env.MEDIA_REVIEW_URL && env.MEDIA_REVIEW_API_KEY
      && env.MEDIA_REVIEW_PROVIDER && env.MEDIA_REVIEW_VERSION
      ? {
          endpoint: env.MEDIA_REVIEW_URL,
          apiKey: env.MEDIA_REVIEW_API_KEY,
          provider: env.MEDIA_REVIEW_PROVIDER,
          version: env.MEDIA_REVIEW_VERSION,
        }
      : undefined,
  );
  return processMediaReviewJobs({
    store: profileMediaStore,
    storage: profileMediaStorage,
    adapter,
    rejectedRetentionMs: (env.MEDIA_REVIEW_REJECTED_RETENTION_HOURS ?? 168) * 3_600_000,
  });
}
