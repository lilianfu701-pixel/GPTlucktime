import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, mediaAssets, memorials, outboxEvents } from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { memorialRoleFor } from "@/modules/memorials/membership";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import {
  buildObjectKey,
  mayHavePublicUrl,
  safeDisplayFileName,
  signatureMatchesDeclared,
  validateDeclaredUpload,
} from "./policy";
import { mediaImageProcessor, mediaStorage } from "./storage";
import type { ImageProcessor, MalwareScanner, MediaStorage } from "./storage";

/** An upload URL is short-lived: long enough to send a file, not to be shared. */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** A read URL for private media. Short so a leaked address expires quickly. */
const READ_URL_TTL_SECONDS = 5 * 60;

export type SignUploadError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "UNSUPPORTED_TYPE"
  | "FILE_TOO_LARGE"
  | "EMPTY_FILE";

export type ProcessError =
  | "ASSET_NOT_FOUND"
  | "NOT_AWAITING_PROCESSING"
  | "BYTES_MISSING"
  | "CONTENT_MISMATCH"
  | "MALWARE_DETECTED"
  | "PROCESSING_FAILED";

export type CompleteError =
  | "ASSET_NOT_FOUND"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "NOT_AWAITING_PROCESSING";

export type DeleteMediaError =
  | "ASSET_NOT_FOUND"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN";

/**
 * Authorizes an upload and issues a short-lived URL.
 *
 * The asset row is created first, in `pending_upload`, so the object key is
 * derived from an identifier we generated. Nothing about the returned URL
 * depends on the client's filename.
 */
export async function signUpload(
  actor: Actor,
  input: {
    memorialId: string;
    fileName: string;
    contentType: string;
    size: number;
  },
  correlationId: string,
): Promise<
  Result<
    {
      mediaAssetId: string;
      url: string;
      headers: Record<string, string>;
      expiresInSeconds: number;
    },
    SignUploadError
  >
> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(input.memorialId, actor.userId);
  // Someone with no role must not learn the memorial exists.
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "publish_content" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const policy = validateDeclaredUpload({
    contentType: input.contentType,
    size: input.size,
  });
  if (!policy.ok) {
    return err(policy.error);
  }

  const assetId = randomUUID();
  const quarantineObjectKey = buildObjectKey({
    memorialId: input.memorialId,
    assetId,
    stage: "quarantine",
    extension: policy.value.extension,
  });

  await db().transaction(async (tx) => {
    await tx.insert(mediaAssets).values({
      id: assetId,
      memorialId: input.memorialId,
      uploadedByUserId: actor.userId,
      kind: policy.value.kind,
      declaredContentType: policy.value.contentType,
      declaredBytes: input.size,
      displayFileName: safeDisplayFileName(input.fileName),
      status: "pending_upload",
      quarantineObjectKey,
    });

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "media.upload_signed",
      resourceType: "media_asset",
      resourceId: assetId,
      newValue: { kind: policy.value.kind, declaredBytes: input.size },
      correlationId,
    });
  });

  const signed = await mediaStorage().createUploadUrl({
    objectKey: quarantineObjectKey,
    contentType: policy.value.contentType,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    maxBytes: policy.value.maxBytes,
  });

  return ok({
    mediaAssetId: assetId,
    url: signed.url,
    headers: signed.headers,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });
}

/**
 * Records that the client finished uploading, and queues the work.
 *
 * Being uploaded is not being available. The asset moves to `scanning` and a
 * worker takes it from there.
 */
export async function markUploadComplete(
  actor: Actor,
  assetId: string,
  correlationId: string,
): Promise<Result<{ mediaAssetId: string; status: "scanning" }, CompleteError>> {
  if (!actor.userId) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const [asset] = await db()
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId));

  if (!asset) {
    return err("ASSET_NOT_FOUND");
  }

  const role = await memorialRoleFor(asset.memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "publish_content" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  if (asset.status !== "pending_upload") {
    return err("NOT_AWAITING_PROCESSING");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(mediaAssets)
      .set({ status: "scanning" })
      .where(eq(mediaAssets.id, assetId));

    await tx.insert(outboxEvents).values({
      topic: "media.process",
      aggregateId: asset.memorialId,
      payload: { mediaAssetId: assetId, correlationId },
    });
  });

  return ok({ mediaAssetId: assetId, status: "scanning" });
}

/**
 * Verifies, processes and publishes an asset. Run by the worker.
 *
 * Images take a different path from video/audio:
 *
 * - **Images** are decoded to pixels, metadata-stripped and re-encoded by sharp.
 *   The decode→encode cycle genuinely neutralizes payloads embedded in IDAT
 *   chunks, JPEG comments or EXIF thumbnails, so no external malware scanner is
 *   needed on this path. GPS coordinates and device serials are dropped.
 *
 * - **Video/audio** cannot be safely re-encoded this way — a full transcode is
 *   expensive and does not guarantee embedded-payload neutralization, so they
 *   require a real malware scanner. Until one is wired, AlwaysCleanScanner
 *   throws in production, which means video/audio uploads are disabled.
 */
export async function processUploadedAsset(
  assetId: string,
  scanner: MalwareScanner,
  correlationId: string,
  processor: ImageProcessor = mediaImageProcessor(),
): Promise<Result<{ status: "ready" }, ProcessError>> {
  const [asset] = await db()
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId));

  if (!asset) {
    return err("ASSET_NOT_FOUND");
  }

  if (asset.status !== "scanning" && asset.status !== "processing") {
    return err("NOT_AWAITING_PROCESSING");
  }

  const storage = mediaStorage();
  const bytes = await storage.getObject(asset.quarantineObjectKey);

  if (!bytes || bytes.length === 0) {
    await reject(assetId, "BYTES_MISSING", correlationId);
    return err("BYTES_MISSING");
  }

  if (!signatureMatchesDeclared(asset.declaredContentType, bytes)) {
    await reject(assetId, "CONTENT_MISMATCH", correlationId);
    await storage.deleteObject(asset.quarantineObjectKey);
    return err("CONTENT_MISMATCH");
  }

  let readyBytes: Uint8Array;
  let readyContentType: string;

  if (asset.kind === "image") {
    // Sharp re-encode replaces the scanner for images: decode to pixels then
    // re-encode = new file, old payloads gone. Metadata (GPS, device serial)
    // is stripped by .rotate() which bakes orientation and drops EXIF.
    try {
      const processed = await processor.stripMetadataAndResize({
        bytes,
        variant: "original",
      });
      readyBytes = processed.bytes;
      readyContentType = processed.contentType;
    } catch {
      await reject(assetId, "PROCESSING_FAILED", correlationId);
      await storage.deleteObject(asset.quarantineObjectKey);
      return err("PROCESSING_FAILED");
    }
  } else {
    // Video/audio still require a real scanner.
    const scan = await scanner.scan(bytes);
    if (!scan.clean) {
      await reject(assetId, "MALWARE_DETECTED", correlationId);
      await storage.deleteObject(asset.quarantineObjectKey);
      return err("MALWARE_DETECTED");
    }
    readyBytes = bytes;
    readyContentType = asset.declaredContentType;
  }

  const extension = asset.quarantineObjectKey.split(".").pop() ?? "bin";
  const readyObjectKey = buildObjectKey({
    memorialId: asset.memorialId,
    assetId,
    stage: "ready",
    variant: "original",
    extension,
  });

  await storage.putObject(readyObjectKey, readyBytes, readyContentType);
  await storage.deleteObject(asset.quarantineObjectKey);

  await db().transaction(async (tx) => {
    await tx
      .update(mediaAssets)
      .set({
        status: "ready",
        readyObjectKey,
        detectedContentType: readyContentType,
        actualBytes: readyBytes.length,
        readyAt: new Date(),
      })
      .where(eq(mediaAssets.id, assetId));

    await tx.insert(auditLogs).values({
      action: "media.ready",
      resourceType: "media_asset",
      resourceId: assetId,
      newValue: { actualBytes: readyBytes.length },
      correlationId,
    });
  });

  return ok({ status: "ready" });
}

async function reject(
  assetId: string,
  reason: string,
  correlationId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .update(mediaAssets)
      .set({ status: "rejected", rejectionReason: reason })
      .where(eq(mediaAssets.id, assetId));

    await tx.insert(auditLogs).values({
      action: "media.rejected",
      resourceType: "media_asset",
      resourceId: assetId,
      newValue: { reason },
      correlationId,
    });
  });
}

export type MediaAddress =
  | { kind: "public"; url: string }
  | { kind: "signed"; url: string; expiresInSeconds: number }
  | { kind: "unavailable" };

/**
 * Produces an address for an asset.
 *
 * A permanent public URL is only ever returned for a ready asset on a public
 * memorial. Everything else gets a short-lived signed URL, so a family that
 * switches a memorial to invite-only is not relying on a CDN to forget an
 * address it already handed out.
 */
export async function addressFor(assetId: string): Promise<MediaAddress> {
  const [row] = await db()
    .select({
      status: mediaAssets.status,
      readyObjectKey: mediaAssets.readyObjectKey,
      deletedAt: mediaAssets.deletedAt,
      visibility: memorials.visibility,
    })
    .from(mediaAssets)
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(and(eq(mediaAssets.id, assetId)));

  if (!row || row.deletedAt || !row.readyObjectKey) {
    return { kind: "unavailable" };
  }

  if (
    mayHavePublicUrl({ status: row.status, memorialVisibility: row.visibility })
  ) {
    const url = mediaStorage().publicUrl(row.readyObjectKey);
    if (url) {
      return { kind: "public", url };
    }
  }

  if (row.status !== "ready") {
    return { kind: "unavailable" };
  }

  return {
    kind: "signed",
    url: await mediaStorage().createReadUrl(
      row.readyObjectKey,
      READ_URL_TTL_SECONDS,
    ),
    expiresInSeconds: READ_URL_TTL_SECONDS,
  };
}

/** Shared address logic used by gallery and manage views. */
async function addressForRow(
  storage: MediaStorage,
  row: {
    status: string;
    readyObjectKey: string | null;
    visibility: "public" | "unlisted" | "invite_only";
  },
): Promise<MediaAddress> {
  if (!row.readyObjectKey) {
    return { kind: "unavailable" };
  }

  if (
    mayHavePublicUrl({
      status: row.status,
      memorialVisibility: row.visibility,
    })
  ) {
    const url = storage.publicUrl(row.readyObjectKey);
    if (url) {
      return { kind: "public", url };
    }
  }

  if (row.status !== "ready") {
    return { kind: "unavailable" };
  }

  return {
    kind: "signed",
    url: await storage.createReadUrl(row.readyObjectKey, READ_URL_TTL_SECONDS),
    expiresInSeconds: READ_URL_TTL_SECONDS,
  };
}

export type GalleryPhoto = {
  id: string;
  altText: string | null;
  url: string;
};

/**
 * Ready images for a memorial's public gallery.
 *
 * Only ready, non-deleted images are returned. The URL is either a permanent
 * public address or a short-lived signed one, depending on the memorial's
 * visibility and whether a public base is configured.
 */
export async function memorialGallery(
  memorialId: string,
): Promise<GalleryPhoto[]> {
  const rows = await db()
    .select({
      id: mediaAssets.id,
      altText: mediaAssets.altText,
      status: mediaAssets.status,
      readyObjectKey: mediaAssets.readyObjectKey,
      visibility: memorials.visibility,
    })
    .from(mediaAssets)
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(
      and(
        eq(mediaAssets.memorialId, memorialId),
        eq(mediaAssets.kind, "image"),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(asc(mediaAssets.createdAt));

  const storage = mediaStorage();
  const photos: GalleryPhoto[] = [];

  for (const row of rows) {
    const address = await addressForRow(storage, row);
    if (address.kind !== "unavailable") {
      photos.push({ id: row.id, altText: row.altText, url: address.url });
    }
  }

  return photos;
}

export type ManageablePhoto = {
  id: string;
  altText: string | null;
  status: string;
  url: string | null;
};

/**
 * All non-deleted images for the manage page.
 *
 * Includes pending and processing assets so the family sees what is in the
 * pipeline, not just what is done.
 */
export async function manageableMedia(
  memorialId: string,
): Promise<ManageablePhoto[]> {
  const rows = await db()
    .select({
      id: mediaAssets.id,
      altText: mediaAssets.altText,
      status: mediaAssets.status,
      readyObjectKey: mediaAssets.readyObjectKey,
      visibility: memorials.visibility,
    })
    .from(mediaAssets)
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(
      and(
        eq(mediaAssets.memorialId, memorialId),
        eq(mediaAssets.kind, "image"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(desc(mediaAssets.createdAt));

  const storage = mediaStorage();
  const photos: ManageablePhoto[] = [];

  for (const row of rows) {
    if (row.status === "ready" && row.readyObjectKey) {
      const address = await addressForRow(storage, row);
      photos.push({
        id: row.id,
        altText: row.altText,
        status: row.status,
        url: address.kind !== "unavailable" ? address.url : null,
      });
    } else {
      photos.push({
        id: row.id,
        altText: row.altText,
        status: row.status,
        url: null,
      });
    }
  }

  return photos;
}

export type FamilyMediaView = {
  status: string;
  altText: string | null;
  url: string | null;
};

/**
 * Status and URL for a single asset, used by the client to poll processing.
 */
export async function familyMediaView(
  actor: Actor,
  assetId: string,
): Promise<Result<FamilyMediaView, "ASSET_NOT_FOUND" | "MEMORIAL_FORBIDDEN">> {
  const [row] = await db()
    .select({
      status: mediaAssets.status,
      altText: mediaAssets.altText,
      readyObjectKey: mediaAssets.readyObjectKey,
      memorialId: mediaAssets.memorialId,
      visibility: memorials.visibility,
    })
    .from(mediaAssets)
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(and(eq(mediaAssets.id, assetId), isNull(mediaAssets.deletedAt)));

  if (!row) {
    return err("ASSET_NOT_FOUND");
  }

  if (!actor.userId) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const role = await memorialRoleFor(row.memorialId, actor.userId);
  if (!role || !canOnMemorial({ actor, role, action: "publish_content" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  let url: string | null = null;
  if (row.status === "ready" && row.readyObjectKey) {
    const address = await addressForRow(mediaStorage(), row);
    url = address.kind !== "unavailable" ? address.url : null;
  }

  return ok({ status: row.status, altText: row.altText, url });
}

/**
 * Soft-deletes a media asset.
 *
 * The ready and quarantine objects are removed from storage, and the row is
 * marked deleted. A hard delete would lose the audit trail, so the row stays.
 */
export async function softDeleteMedia(
  actor: Actor,
  assetId: string,
  correlationId: string,
): Promise<Result<{ deleted: true }, DeleteMediaError>> {
  if (!actor.userId) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const [asset] = await db()
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, assetId), isNull(mediaAssets.deletedAt)));

  if (!asset) {
    return err("ASSET_NOT_FOUND");
  }

  const role = await memorialRoleFor(asset.memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }
  if (!canOnMemorial({ actor, role, action: "publish_content" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const storage = mediaStorage();

  // Remove objects from storage. Both operations are best-effort: if the
  // object is already gone (double-delete, purge) that is fine.
  if (asset.readyObjectKey) {
    await storage.deleteObject(asset.readyObjectKey).catch(() => {});
  }
  await storage.deleteObject(asset.quarantineObjectKey).catch(() => {});

  await db().transaction(async (tx) => {
    await tx
      .update(mediaAssets)
      .set({ status: "deleted", deletedAt: new Date() })
      .where(eq(mediaAssets.id, assetId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "media.deleted",
      resourceType: "media_asset",
      resourceId: assetId,
      correlationId,
    });
  });

  return ok({ deleted: true });
}
