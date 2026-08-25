import "server-only";

import { db } from "@/infrastructure/db/client";
import { readEnv } from "@/shared/env";

import { MediaReviewStore } from "./media-review-store";
import { S3StorageAdapter } from "./media-service";
import { VercelBlobStorageAdapter } from "./vercel-blob-storage";

const env = readEnv(process.env);

export const profileMediaStore = new MediaReviewStore(db, {
  maximumPhotos: env.PROFILE_MEDIA_MAX_PHOTOS,
});

export const profileMediaStorage = env.BLOB_READ_WRITE_TOKEN
  ? new VercelBlobStorageAdapter({ token: env.BLOB_READ_WRITE_TOKEN })
  : env.PROFILE_MEDIA_STORAGE_ENDPOINT
    && env.PROFILE_MEDIA_STORAGE_REGION
    && env.PROFILE_MEDIA_STORAGE_BUCKET
    && env.PROFILE_MEDIA_STORAGE_ACCESS_KEY
    && env.PROFILE_MEDIA_STORAGE_SECRET_KEY
    ? new S3StorageAdapter({
        endpoint: env.PROFILE_MEDIA_STORAGE_ENDPOINT,
        region: env.PROFILE_MEDIA_STORAGE_REGION,
        bucket: env.PROFILE_MEDIA_STORAGE_BUCKET,
        accessKeyId: env.PROFILE_MEDIA_STORAGE_ACCESS_KEY,
        secretAccessKey: env.PROFILE_MEDIA_STORAGE_SECRET_KEY,
      })
    : null;

export const profileMediaRuntime = {
  tokenSecret: env.PROFILE_MEDIA_TOKEN_SECRET,
  maximumSizeBytes: env.PROFILE_MEDIA_MAX_BYTES,
  expirySeconds: env.PROFILE_MEDIA_UPLOAD_EXPIRY_SECONDS,
};
