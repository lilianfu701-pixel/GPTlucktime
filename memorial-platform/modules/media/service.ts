import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
import { mediaStorage } from "./storage";
import type { MalwareScanner } from "./storage";

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
  | "MALWARE_DETECTED";

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
  assetId: string,
  correlationId: string,
): Promise<Result<{ status: "scanning" }, ProcessError>> {
  const [asset] = await db()
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId));

  if (!asset) {
    return err("ASSET_NOT_FOUND");
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

  return ok({ status: "scanning" });
}

/**
 * Scans, verifies and publishes an asset. Run by the worker.
 *
 * The bytes are checked against the declared type here, not only at sign time:
 * a signed URL says what may be uploaded, it does not guarantee what was.
 */
export async function processUploadedAsset(
  assetId: string,
  scanner: MalwareScanner,
  correlationId: string,
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

  const scan = await scanner.scan(bytes);
  if (!scan.clean) {
    await reject(assetId, "MALWARE_DETECTED", correlationId);
    // The file stays out of the ready prefix and the quarantine copy goes.
    await storage.deleteObject(asset.quarantineObjectKey);
    return err("MALWARE_DETECTED");
  }

  if (!signatureMatchesDeclared(asset.declaredContentType, bytes)) {
    await reject(assetId, "CONTENT_MISMATCH", correlationId);
    await storage.deleteObject(asset.quarantineObjectKey);
    return err("CONTENT_MISMATCH");
  }

  const extension = asset.quarantineObjectKey.split(".").pop() ?? "bin";
  const readyObjectKey = buildObjectKey({
    memorialId: asset.memorialId,
    assetId,
    stage: "ready",
    variant: "original",
    extension,
  });

  await storage.putObject(readyObjectKey, bytes, asset.declaredContentType);
  await storage.deleteObject(asset.quarantineObjectKey);

  await db().transaction(async (tx) => {
    await tx
      .update(mediaAssets)
      .set({
        status: "ready",
        readyObjectKey,
        detectedContentType: asset.declaredContentType,
        actualBytes: bytes.length,
        readyAt: new Date(),
      })
      .where(eq(mediaAssets.id, assetId));

    await tx.insert(auditLogs).values({
      action: "media.ready",
      resourceType: "media_asset",
      resourceId: assetId,
      newValue: { actualBytes: bytes.length },
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
