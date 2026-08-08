import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { photoCompleteRequestSchema, photoUploadRequestSchema } from "./profile-schema";

export type ObjectMetadata = { sizeBytes: number; mimeType: string };

export interface StorageAdapter {
  createPutUrl(input: {
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    expiresInSeconds: number;
  }): Promise<string>;
  headObject(objectKey: string): Promise<ObjectMetadata | null>;
  copyObject(sourceObjectKey: string, destinationObjectKey: string): Promise<void>;
  readPrefix(objectKey: string, maximumBytes: number): Promise<Uint8Array>;
  deleteObject(objectKey: string): Promise<void>;
}

export type ReservedUpload = {
  id: string;
  userId: string;
  profileId: string;
  objectKey: string;
  mimeType: string;
  declaredSizeBytes: number;
  tokenHash: string;
  idempotencyHash: string;
  expiresAt: Date;
  completedPhotoId: string | null;
};

export interface PhotoMediaStore {
  reserveUpload(input: Omit<ReservedUpload, "id" | "profileId" | "completedPhotoId">): Promise<ReservedUpload>;
  findUpload(userId: string, uploadId: string): Promise<ReservedUpload | null>;
  completeUpload(
    userId: string,
    uploadId: string,
    finalize: (upload: ReservedUpload) => Promise<ObjectMetadata & { objectKey: string }>,
  ): Promise<{
    photo: { id: string; moderationStatus: string; [key: string]: unknown };
    job: { id: string; status: string; [key: string]: unknown };
  }>;
  listPhotosForUser(userId: string): Promise<Array<Record<string, unknown>>>;
  markPhotoRemoved(userId: string, photoId: string): Promise<boolean>;
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;

  constructor(private readonly configuration: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle?: boolean;
    requestTimeoutMs?: number;
    client?: S3Client;
  }) {
    this.client = configuration.client ?? new S3Client({
      endpoint: configuration.endpoint,
      region: configuration.region,
      forcePathStyle: configuration.forcePathStyle ?? true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    });
  }

  createPutUrl(input: { objectKey: string; mimeType: string; sizeBytes: number; expiresInSeconds: number }) {
    return getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.configuration.bucket,
      Key: input.objectKey,
      ContentType: input.mimeType,
      ContentLength: input.sizeBytes,
    }), { expiresIn: Math.min(600, input.expiresInSeconds) });
  }

  async headObject(objectKey: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.configuration.bucket,
        Key: objectKey,
      }), { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
      if (result.ContentLength === undefined || !result.ContentType) return null;
      return { sizeBytes: result.ContentLength, mimeType: result.ContentType.split(";", 1)[0]!.toLowerCase() };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw new Error("STORAGE_UNAVAILABLE");
    }
  }

  async copyObject(sourceObjectKey: string, destinationObjectKey: string) {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.configuration.bucket,
      Key: destinationObjectKey,
      CopySource: `${this.configuration.bucket}/${sourceObjectKey.split("/").map(encodeURIComponent).join("/")}`,
    }), { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
  }

  async readPrefix(objectKey: string, maximumBytes: number) {
    const controller = new AbortController();
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.configuration.bucket,
      Key: objectKey,
      Range: `bytes=0-${Math.max(0, maximumBytes - 1)}`,
    }), { abortSignal: AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000),
    ]) });
    if (!result.Body) throw new Error("STORAGE_OBJECT_MISSING");
    return collectBoundedBody(result.Body, maximumBytes, controller);
  }

  async deleteObject(objectKey: string) {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.configuration.bucket,
      Key: objectKey,
    }), { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
  }
}

export async function collectBoundedBody(body: unknown, maximumBytes: number, controller: AbortController) {
  if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
    throw new Error("STORAGE_BODY_INVALID");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const rawChunk of body as AsyncIterable<Uint8Array>) {
    const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
    total += chunk.byteLength;
    if (total > maximumBytes) {
      controller.abort();
      throw new Error("STORAGE_OBJECT_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

const digest = (secret: string, ...parts: string[]) =>
  createHmac("sha256", secret).update(parts.join("\u0000")).digest("base64url");

const safeEqual = (left: string, right: string) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const extensionForMime: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function isOwnedMediaKey(objectKey: string, userId: string) {
  const escaped = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^profile-media/${escaped}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(?:jpg|png|webp)$`, "i").test(objectKey);
}

export function isOwnedReviewKey(objectKey: string, userId: string) {
  const escaped = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^profile-review/${escaped}/[0-9a-f-]{36}\\.(?:jpg|png|webp)$`, "i").test(objectKey);
}

type HandlerSession = { user: { id: string } };
type HandlerDependencies = {
  getSession(headers: Headers): Promise<HandlerSession | null>;
  storage: StorageAdapter;
  store: PhotoMediaStore;
  tokenSecret: string;
  clock?: () => Date;
  maximumSizeBytes?: number;
  expirySeconds?: number;
};

const apiError = (code: string, status: number) => Response.json({ code, message: code }, { status });

const actionableReason: Record<string, string> = {
  CONTENT_UNSAFE: "PHOTO_CONTENT_UNSAFE",
  LIVENESS_FAILED: "PHOTO_LIVENESS_FAILED",
  MALWARE_DETECTED: "PHOTO_INVALID_FILE",
  SIGNATURE_MIME_MISMATCH: "PHOTO_INVALID_FILE",
  IMAGE_METADATA_INVALID: "PHOTO_INVALID_FILE",
  IMAGE_DIMENSIONS_EXCEEDED: "PHOTO_INVALID_FILE",
};

export type SafeUserPhoto = {
  id: string;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
};

export function safeUserPhoto(photo: Record<string, unknown>): SafeUserPhoto {
  const status: SafeUserPhoto["status"] = ["pending", "approved", "rejected"].includes(String(photo.moderationStatus))
    ? (String(photo.moderationStatus) as SafeUserPhoto["status"])
    : "pending";
  return {
    id: String(photo.id),
    status,
    reason: status === "rejected"
      ? actionableReason[String(photo.moderationReasonCode)] ?? "PHOTO_REJECTED"
      : null,
    width: typeof photo.width === "number" ? photo.width : null,
    height: typeof photo.height === "number" ? photo.height : null,
    createdAt: photo.createdAt instanceof Date ? photo.createdAt.toISOString() : String(photo.createdAt),
  };
}

export function createPhotoListHandler(input: {
  getSession(headers: Headers): Promise<HandlerSession | null>;
  store: Pick<PhotoMediaStore, "listPhotosForUser">;
}) {
  return async (request: Request) => {
    let session: HandlerSession | null;
    try { session = await input.getSession(request.headers); } catch { return apiError("INTERNAL_ERROR", 500); }
    if (!session) return apiError("UNAUTHORIZED", 401);
    try {
      const photos = await input.store.listPhotosForUser(session.user.id);
      return Response.json({ photos: photos.map(safeUserPhoto) });
    } catch {
      return apiError("INTERNAL_ERROR", 500);
    }
  };
}

export function createPhotoRemoveHandler(input: {
  getSession(headers: Headers): Promise<HandlerSession | null>;
  store: Pick<PhotoMediaStore, "markPhotoRemoved">;
}) {
  return async (request: Request) => {
    let session: HandlerSession | null;
    try { session = await input.getSession(request.headers); } catch { return apiError("INTERNAL_ERROR", 500); }
    if (!session) return apiError("UNAUTHORIZED", 401);
    let body: unknown;
    try { body = await request.json(); } catch { return apiError("INVALID_PHOTO", 400); }
    const photoId = body && typeof body === "object" ? (body as Record<string, unknown>).photoId : null;
    if (typeof photoId !== "string" || !/^[0-9a-f-]{36}$/i.test(photoId)) return apiError("INVALID_PHOTO", 400);
    return await input.store.markPhotoRemoved(session.user.id, photoId)
      ? Response.json({ removed: true })
      : apiError("PHOTO_NOT_FOUND", 404);
  };
}

export function createPhotoUploadHandler(input: HandlerDependencies) {
  const maximumSizeBytes = input.maximumSizeBytes ?? 10 * 1024 * 1024;
  const expirySeconds = Math.min(600, input.expirySeconds ?? 300);
  return async (request: Request) => {
    let session: HandlerSession | null;
    try { session = await input.getSession(request.headers); } catch { return apiError("INTERNAL_ERROR", 500); }
    if (!session) return apiError("UNAUTHORIZED", 401);
    let body: unknown;
    try { body = await request.json(); } catch { return apiError("INVALID_PHOTO_UPLOAD", 400); }
    const parsed = photoUploadRequestSchema.safeParse(body);
    if (!parsed.success || parsed.data.sizeBytes > maximumSizeBytes) {
      return apiError("INVALID_PHOTO_UPLOAD", 400);
    }
    const now = input.clock?.() ?? new Date();
    const uploadToken = digest(input.tokenSecret, "upload-token", session.user.id, parsed.data.idempotencyKey);
    const tokenHash = digest(input.tokenSecret, "stored-token", uploadToken);
    const idempotencyHash = digest(input.tokenSecret, "idempotency", session.user.id, parsed.data.idempotencyKey);
    const objectKey = `profile-media/${session.user.id}/${randomUUID()}/${randomUUID()}.${extensionForMime[parsed.data.mimeType]}`;
    try {
      const reserved = await input.store.reserveUpload({
        userId: session.user.id,
        objectKey,
        mimeType: parsed.data.mimeType,
        declaredSizeBytes: parsed.data.sizeBytes,
        tokenHash,
        idempotencyHash,
        expiresAt: new Date(now.getTime() + expirySeconds * 1_000),
      });
      if (!isOwnedMediaKey(reserved.objectKey, session.user.id)) return apiError("INVALID_MEDIA_KEY", 409);
      const uploadUrl = await input.storage.createPutUrl({
        objectKey: reserved.objectKey,
        mimeType: reserved.mimeType,
        sizeBytes: reserved.declaredSizeBytes,
        expiresInSeconds: Math.max(1, Math.min(600, Math.floor((reserved.expiresAt.getTime() - now.getTime()) / 1_000))),
      });
      return Response.json({
        uploadId: reserved.id,
        uploadToken,
        uploadUrl,
        expiresAt: reserved.expiresAt.toISOString(),
        requiredHeaders: {
          "content-type": reserved.mimeType,
          "content-length": String(reserved.declaredSizeBytes),
        },
      });
    } catch (error) {
      if (error instanceof Error && ["PROFILE_REQUIRED", "PHOTO_QUOTA_EXCEEDED"].includes(error.message)) {
        return apiError(error.message, 409);
      }
      return apiError("INTERNAL_ERROR", 500);
    }
  };
}
export function createPhotoCompleteHandler(input: HandlerDependencies) {
  return async (request: Request) => {
    let session: HandlerSession | null;
    try { session = await input.getSession(request.headers); } catch { return apiError("INTERNAL_ERROR", 500); }
    if (!session) return apiError("UNAUTHORIZED", 401);
    let body: unknown;
    try { body = await request.json(); } catch { return apiError("INVALID_PHOTO_COMPLETION", 400); }
    const parsed = photoCompleteRequestSchema.safeParse(body);
    if (!parsed.success) return apiError("INVALID_PHOTO_COMPLETION", 400);
    try {
      const upload = await input.store.findUpload(session.user.id, parsed.data.uploadId);
      const expectedHash = digest(input.tokenSecret, "stored-token", parsed.data.uploadToken);
      if (!upload || !safeEqual(upload.tokenHash, expectedHash) || !isOwnedMediaKey(upload.objectKey, session.user.id)) {
        return apiError("UPLOAD_NOT_FOUND", 404);
      }
      const now = input.clock?.() ?? new Date();
      if (upload.expiresAt <= now) return apiError("UPLOAD_EXPIRED", 409);
      const finalObjectKey = `profile-review/${session.user.id}/${upload.id}.${extensionForMime[upload.mimeType]}`;
      const result = await input.store.completeUpload(session.user.id, upload.id, async (lockedUpload) => {
        const stagingMetadata = await input.storage.headObject(lockedUpload.objectKey);
        if (!stagingMetadata || stagingMetadata.sizeBytes !== lockedUpload.declaredSizeBytes
          || stagingMetadata.mimeType !== lockedUpload.mimeType) {
          if (stagingMetadata) await input.storage.deleteObject(lockedUpload.objectKey).catch(() => undefined);
          throw new Error("UPLOAD_METADATA_MISMATCH");
        }
        await input.storage.copyObject(lockedUpload.objectKey, finalObjectKey);
        const finalMetadata = await input.storage.headObject(finalObjectKey);
        if (!finalMetadata || finalMetadata.sizeBytes !== lockedUpload.declaredSizeBytes
          || finalMetadata.mimeType !== lockedUpload.mimeType) {
          await input.storage.deleteObject(finalObjectKey).catch(() => undefined);
          throw new Error("IMMUTABLE_COPY_MISMATCH");
        }
        return { ...finalMetadata, objectKey: finalObjectKey };
      });
      await input.storage.deleteObject(upload.objectKey).catch(() => undefined);
      return Response.json({ photo: safeUserPhoto(result.photo) });
    } catch (error) {
      if (error instanceof Error && error.message === "UPLOAD_EXPIRED") {
        return apiError("UPLOAD_EXPIRED", 409);
      }
      if (error instanceof Error && error.message === "UPLOAD_METADATA_MISMATCH") {
        return apiError("UPLOAD_METADATA_MISMATCH", 409);
      }
      return apiError("INTERNAL_ERROR", 500);
    }
  };
}
