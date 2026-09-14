import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  contentMedia,
  mediaAssets,
  memorials,
  outboxEvents,
} from "@/db/schema";
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

/**
 * Excludes a memorial's final-disposition (身后安置) photo from its general
 * image pool. That photo is referenced only by `memorials.disposition_media_id`
 * and shown in the disposition section; without this it would leak into the
 * gallery and, being the newest upload, hijack the portrait (遗像). Every query
 * using it joins `memorials`, so the column is in scope. `is distinct from`
 * keeps assets when the memorial has no disposition photo (NULL).
 */
const NOT_DISPOSITION_PHOTO = sql`${mediaAssets.id} is distinct from ${memorials.dispositionMediaId}`;

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

  // An avatar belongs to a person, not a memorial: the uploader is the only
  // one who may finish it. Everything else is authorised by memorial role.
  if (asset.memorialId === null) {
    if (asset.uploadedByUserId !== actor.userId) {
      return err("MEMORIAL_FORBIDDEN");
    }
  } else {
    const role = await memorialRoleFor(asset.memorialId, actor.userId);
    if (!role) {
      return err("MEMORIAL_NOT_FOUND");
    }
    if (!canOnMemorial({ actor, role, action: "publish_content" })) {
      return err("MEMORIAL_FORBIDDEN");
    }
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
      aggregateId: asset.memorialId ?? assetId,
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
    } catch (error) {
      // Surface the actual sharp/libvips message so the family sees WHY, and
      // it lands in the platform logs for triage. The reason is capped and
      // stripped of stack; the mode-string is the useful signal ("Input
      // buffer contains unsupported image format", "premature end of JPEG",
      // "linked library not loaded", etc).
      const reason = error instanceof Error ? error.message : String(error);
      const short = ("PROCESSING_FAILED: " + reason).slice(0, 240);
      // eslint-disable-next-line no-console
      console.error("[media.process] sharp threw:", reason);
      await reject(assetId, short, correlationId);
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
    // Keys are namespaced by whatever owns the asset: a memorial, or for an
    // avatar the account it belongs to. Both are server-generated UUIDs.
    memorialId: asset.memorialId ?? asset.uploadedByUserId ?? assetId,
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

/**
 * Bytes of a ready asset that is safe to serve at a permanent public URL: it
 * must be `ready` and belong to a `public`, `published` memorial. This lets the
 * public media route stream an image while the R2 bucket itself stays private —
 * an invite-only or unlisted memorial's photo is never reachable this way (its
 * memorial is not public), and neither is a still-quarantined upload (its key is
 * not a `readyObjectKey`). Returns null for anything that fails the check, so
 * the caller answers 404 without confirming that a key exists.
 */
export async function readPublicObject(
  objectKey: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const [row] = await db()
    .select({
      status: mediaAssets.status,
      readyObjectKey: mediaAssets.readyObjectKey,
      deletedAt: mediaAssets.deletedAt,
      visibility: memorials.visibility,
      memorialStatus: memorials.status,
    })
    .from(mediaAssets)
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(eq(mediaAssets.readyObjectKey, objectKey));

  if (
    !row ||
    row.deletedAt ||
    row.status !== "ready" ||
    row.visibility !== "public" ||
    row.memorialStatus !== "published"
  ) {
    return null;
  }

  const bytes = await mediaStorage().getObject(objectKey);
  if (!bytes) {
    return null;
  }

  return { bytes, contentType: contentTypeForKey(objectKey) };
}

function contentTypeForKey(objectKey: string): string {
  const ext = objectKey.slice(objectKey.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
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
        // Photos attached to a chapter (or other content) belong there, not in
        // the general slideshow.
        sql`not exists (select 1 from ${contentMedia} where ${contentMedia.mediaId} = ${mediaAssets.id})`,
        NOT_DISPOSITION_PHOTO,
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
        // Chapter photos are managed inside the chapter editor, not here.
        sql`not exists (select 1 from ${contentMedia} where ${contentMedia.mediaId} = ${mediaAssets.id})`,
        NOT_DISPOSITION_PHOTO,
      ),
    )
    // Oldest first so a newly uploaded photo lands at the end, matching the
    // public gallery order.
    .orderBy(asc(mediaAssets.createdAt));

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

/**
 * The portrait for each of several memorials, keyed by slug.
 *
 * A memorial's portrait is its most recent ready photograph — the same one the
 * manage page shows as the 遗像. Used by the family chart so a relative who has
 * their own memorial appears as their portrait rather than an initial.
 */
export async function portraitsBySlug(
  slugs: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (slugs.length === 0) return found;

  const rows = await db()
    .select({
      slug: memorials.slug,
      status: mediaAssets.status,
      readyObjectKey: mediaAssets.readyObjectKey,
      visibility: memorials.visibility,
      createdAt: mediaAssets.createdAt,
    })
    .from(mediaAssets)
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(
      and(
        inArray(memorials.slug, [...slugs]),
        eq(mediaAssets.kind, "image"),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
        // The 遗像 only — photos attached to a life chapter (or other content)
        // are not the portrait and must not stand in for it on the chart.
        sql`not exists (select 1 from ${contentMedia} where ${contentMedia.mediaId} = ${mediaAssets.id})`,
        NOT_DISPOSITION_PHOTO,
      ),
    )
    .orderBy(asc(mediaAssets.createdAt));

  const storage = mediaStorage();
  // Ordered oldest first, so the last write per slug is the newest photo.
  for (const row of rows) {
    const address = await addressForRow(storage, row);
    if (address.kind !== "unavailable") {
      found.set(row.slug, address.url);
    }
  }

  return found;
}

/**
 * A freshly-resolved address for a public memorial's 遗像, by slug.
 *
 * Only ever serves the portrait of a public, published memorial — the guard is
 * in this query, so the stable `/api/portrait/[slug]` route it backs cannot be
 * used to fetch a private page's photo by guessing a slug. Returns a permanent
 * public URL when a CDN base is configured, otherwise a fresh short-lived signed
 * URL; the route redirects to whichever, resolved per request so a cached page
 * never holds an expired signature.
 */
async function newestPublicPortraitKey(slug: string): Promise<string | null> {
  const rows = await db()
    .select({
      readyObjectKey: mediaAssets.readyObjectKey,
      createdAt: mediaAssets.createdAt,
    })
    .from(mediaAssets)
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(
      and(
        eq(memorials.slug, slug),
        eq(memorials.visibility, "public"),
        eq(memorials.status, "published"),
        isNull(memorials.deletionRequestedAt),
        eq(mediaAssets.kind, "image"),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
        sql`not exists (select 1 from ${contentMedia} where ${contentMedia.mediaId} = ${mediaAssets.id})`,
        NOT_DISPOSITION_PHOTO,
      ),
    )
    .orderBy(asc(mediaAssets.createdAt));

  // Oldest first, so the last row is the newest photo — the current 遗像.
  return rows.at(-1)?.readyObjectKey ?? null;
}

export async function publicPortraitUrlForSlug(
  slug: string,
): Promise<string | null> {
  const key = await newestPublicPortraitKey(slug);
  if (!key) return null;

  const address = await addressForRow(mediaStorage(), {
    status: "ready",
    readyObjectKey: key,
    visibility: "public",
  });
  return address.kind === "unavailable" ? null : address.url;
}

/**
 * The raw bytes of a public memorial's 遗像, by slug, for the stable
 * `/api/portrait/[slug]` route to serve directly.
 *
 * Serving the bytes (rather than a redirect to a signed URL) gives the portrait
 * a permanent, cacheable, crawler-friendly address — one a social card or
 * search engine can fetch, and one an hour-cached homepage can point at without
 * the link expiring. Public+published only, so a slug guess cannot pull a
 * private page's photo.
 */
export async function publicPortraitBytesForSlug(
  slug: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const key = await newestPublicPortraitKey(slug);
  if (!key) return null;

  const bytes = await mediaStorage().getObject(key);
  if (!bytes) return null;

  return { bytes, contentType: sniffImageMime(bytes) };
}

export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return "image/webp";
}

/**
 * The 遗像 for a memorial, read straight from storage and inlined as a data URL.
 *
 * Used by the obituary poster, which draws the portrait onto a canvas: reading
 * the bytes here (rather than fetching a signed or proxied URL over HTTP) avoids
 * canvas tainting and works even while the memorial is still a private draft.
 */
export async function portraitDataUrlForSlug(
  slug: string,
): Promise<string | null> {
  const rows = await db()
    .select({
      readyObjectKey: mediaAssets.readyObjectKey,
      createdAt: mediaAssets.createdAt,
    })
    .from(mediaAssets)
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(
      and(
        eq(memorials.slug, slug),
        eq(mediaAssets.kind, "image"),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
        sql`not exists (select 1 from ${contentMedia} where ${contentMedia.mediaId} = ${mediaAssets.id})`,
        NOT_DISPOSITION_PHOTO,
      ),
    )
    .orderBy(asc(mediaAssets.createdAt));

  const newest = rows[rows.length - 1];
  if (!newest?.readyObjectKey) return null;

  const bytes = await mediaStorage().getObject(newest.readyObjectKey);
  if (!bytes || bytes.length === 0) return null;

  const mime = sniffImageMime(bytes);
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${mime};base64,${base64}`;
}

export type OwnerPhoto = {
  ownerId: string;
  mediaId: string;
  caption: string | null;
  displayOrder: number;
  status: string;
  /** Null until the asset is ready (or when not publicly addressable). */
  url: string | null;
};

/**
 * Photos attached to content items (a life chapter, and later a contribution).
 *
 * One query for a batch of owners, so a page rendering many chapters resolves
 * their galleries together. `readyOnly` is true for public rendering — a reader
 * never sees a photo still in the pipeline — and false for the family's editor,
 * which shows processing photos so they know an upload is in flight.
 */
export async function contentMediaPhotos(
  ownerType: string,
  ownerIds: string[],
  options: { readyOnly: boolean },
): Promise<OwnerPhoto[]> {
  if (ownerIds.length === 0) return [];

  const conditions = [
    eq(contentMedia.ownerType, ownerType),
    inArray(contentMedia.ownerId, ownerIds),
    isNull(mediaAssets.deletedAt),
  ];
  if (options.readyOnly) {
    conditions.push(eq(mediaAssets.status, "ready"));
  }

  const rows = await db()
    .select({
      ownerId: contentMedia.ownerId,
      mediaId: contentMedia.mediaId,
      caption: contentMedia.caption,
      displayOrder: contentMedia.displayOrder,
      status: mediaAssets.status,
      readyObjectKey: mediaAssets.readyObjectKey,
      visibility: memorials.visibility,
    })
    .from(contentMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, contentMedia.mediaId))
    .innerJoin(memorials, eq(memorials.id, mediaAssets.memorialId))
    .where(and(...conditions))
    .orderBy(asc(contentMedia.ownerId), asc(contentMedia.displayOrder));

  const storage = mediaStorage();
  const photos: OwnerPhoto[] = [];

  for (const row of rows) {
    let url: string | null = null;
    if (row.status === "ready" && row.readyObjectKey) {
      const address = await addressForRow(storage, row);
      url = address.kind !== "unavailable" ? address.url : null;
    }
    photos.push({
      ownerId: row.ownerId,
      mediaId: row.mediaId,
      caption: row.caption,
      displayOrder: row.displayOrder,
      status: row.status,
      url,
    });
  }

  return photos;
}

export type FamilyMediaView = {
  status: string;
  altText: string | null;
  url: string | null;
  /** Why processing rejected the asset, when status is "rejected". */
  rejectionReason: string | null;
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
      rejectionReason: mediaAssets.rejectionReason,
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

  // The join above is on memorials, so a row here always has one.
  if (row.memorialId === null) {
    return err("ASSET_NOT_FOUND");
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

  return ok({
    status: row.status,
    altText: row.altText,
    url,
    rejectionReason: row.status === "rejected" ? row.rejectionReason : null,
  });
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

  // An avatar is deleted by the person it belongs to; memorial media by
  // someone who may publish on that memorial.
  if (asset.memorialId === null) {
    if (asset.uploadedByUserId !== actor.userId) {
      return err("MEMORIAL_FORBIDDEN");
    }
  } else {
    const role = await memorialRoleFor(asset.memorialId, actor.userId);
    if (!role) {
      return err("MEMORIAL_NOT_FOUND");
    }
    if (!canOnMemorial({ actor, role, action: "publish_content" })) {
      return err("MEMORIAL_FORBIDDEN");
    }
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
