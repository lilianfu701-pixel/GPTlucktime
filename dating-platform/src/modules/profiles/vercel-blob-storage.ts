import "server-only";

import {
  BlobNotFoundError,
  BlobPreconditionFailedError,
  copy,
  del,
  get,
  head,
  issueSignedToken,
  presignUrl,
} from "@vercel/blob";

import { collectBoundedBody, type ObjectMetadata, type StorageAdapter } from "./media-service";

export type VercelBlobSdk = Pick<typeof import("@vercel/blob"),
  "issueSignedToken" | "presignUrl" | "head" | "copy" | "get" | "del">;

const defaultSdk: VercelBlobSdk = { issueSignedToken, presignUrl, head, copy, get, del };
const stableErrors = new Set([
  "STORAGE_BODY_INVALID",
  "STORAGE_OBJECT_MISSING",
  "STORAGE_OBJECT_TOO_LARGE",
  "STORAGE_PATH_INVALID",
  "STORAGE_PRECONDITION_FAILED",
  "STORAGE_VERSIONING_REQUIRED",
]);

const failUnavailable = (): never => { throw new Error("STORAGE_UNAVAILABLE"); };

function preserveStableError(error: unknown): never {
  if (error instanceof Error && stableErrors.has(error.message)) throw error;
  return failUnavailable();
}

function exactPathname(pathname: string) {
  const segments = pathname.split("/");
  const hasAsciiControl = [...pathname].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!pathname
    || pathname.startsWith("/")
    || pathname.includes("\\")
    || pathname.includes("%")
    || pathname.includes("?")
    || pathname.includes("#")
    || hasAsciiControl
    || /^[a-z][a-z\d+.-]*:/i.test(pathname)
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("STORAGE_PATH_INVALID");
  }
  return pathname;
}

function isPrivateBlobUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.endsWith(".private.blob.vercel-storage.com")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function normalizedMetadata(result: Awaited<ReturnType<VercelBlobSdk["head"]>>, pathname: string): ObjectMetadata {
  const etag = typeof result.etag === "string" ? result.etag : "";
  const mimeType = typeof result.contentType === "string"
    ? result.contentType.split(";", 1)[0]!.trim().toLowerCase()
    : "";
  if (result.pathname !== pathname
    || !isPrivateBlobUrl(result.url)
    || !Number.isSafeInteger(result.size)
    || result.size < 0
    || !mimeType
    || !etag.trim()) {
    throw new Error("STORAGE_VERSIONING_REQUIRED");
  }
  return { sizeBytes: result.size, mimeType, etag, versionId: `blob-etag:${etag}` };
}

export class VercelBlobStorageAdapter implements StorageAdapter {
  private readonly sdk: VercelBlobSdk;

  constructor(private readonly configuration: {
    token: string;
    requestTimeoutMs?: number;
    sdk?: VercelBlobSdk;
  }) {
    this.sdk = configuration.sdk ?? defaultSdk;
  }

  private timeoutSignal() {
    return AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000);
  }

  private metadataMatchesPriorCopy(
    source: ObjectMetadata,
    destination: ObjectMetadata,
    sourceETag: string,
  ) {
    return source.etag === sourceETag
      && destination.sizeBytes === source.sizeBytes
      && destination.mimeType === source.mimeType;
  }

  private async confirmPriorCopy(
    sourcePathname: string,
    destinationPathname: string,
    sourceETag: string,
  ) {
    const source = await this.headObject(sourcePathname);
    if (!source || source.etag !== sourceETag) return false;
    const destination = await this.headObject(destinationPathname);
    return destination !== null
      && this.metadataMatchesPriorCopy(source, destination, sourceETag);
  }

  async createPutUrl(input: {
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    expiresInSeconds: number;
  }) {
    const pathname = exactPathname(input.objectKey);
    const lifetimeSeconds = Math.min(600, Math.max(1, Math.floor(input.expiresInSeconds)));
    const validUntil = Date.now() + lifetimeSeconds * 1_000;
    try {
      const signedToken = await this.sdk.issueSignedToken({
        token: this.configuration.token,
        pathname,
        operations: ["put"],
        validUntil,
        allowedContentTypes: [input.mimeType],
        maximumSizeInBytes: input.sizeBytes,
        abortSignal: this.timeoutSignal(),
      });
      const { presignedUrl } = await this.sdk.presignUrl(signedToken, {
        access: "private",
        operation: "put",
        pathname,
        validUntil,
        allowedContentTypes: [input.mimeType],
        maximumSizeInBytes: input.sizeBytes,
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      if (presignedUrl.includes(this.configuration.token)) failUnavailable();
      return presignedUrl;
    } catch (error) {
      preserveStableError(error);
    }
  }

  async headObject(objectKey: string): Promise<ObjectMetadata | null> {
    const pathname = exactPathname(objectKey);
    try {
      const result = await this.sdk.head(pathname, {
        token: this.configuration.token,
        abortSignal: this.timeoutSignal(),
      });
      return normalizedMetadata(result, pathname);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      preserveStableError(error);
    }
  }

  async copyObject(sourceObjectKey: string, destinationObjectKey: string, options: {
    sourceETag: string;
    sourceVersionId?: string;
  }) {
    const sourcePathname = exactPathname(sourceObjectKey);
    const destinationPathname = exactPathname(destinationObjectKey);
    let metadata: ObjectMetadata;
    try {
      const source = await this.sdk.head(sourcePathname, {
        token: this.configuration.token,
        abortSignal: this.timeoutSignal(),
      });
      metadata = normalizedMetadata(source, sourcePathname);
    } catch (error) {
      preserveStableError(error);
    }
    if (metadata.etag !== options.sourceETag) throw new Error("STORAGE_PRECONDITION_FAILED");

    const existingDestination = await this.headObject(destinationPathname);
    if (existingDestination) {
      if (this.metadataMatchesPriorCopy(metadata, existingDestination, options.sourceETag)
        && await this.confirmPriorCopy(sourcePathname, destinationPathname, options.sourceETag)) {
        return;
      }
      throw new Error("STORAGE_PRECONDITION_FAILED");
    }

    let copied: Awaited<ReturnType<VercelBlobSdk["copy"]>>;
    try {
      copied = await this.sdk.copy(sourcePathname, destinationPathname, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: metadata.mimeType,
        ifMatch: options.sourceETag,
        token: this.configuration.token,
        abortSignal: this.timeoutSignal(),
      });
    } catch (error) {
      let priorCopyConfirmed = false;
      try {
        priorCopyConfirmed = await this.confirmPriorCopy(
          sourcePathname,
          destinationPathname,
          options.sourceETag,
        );
      } catch {
        // A recovery HEAD failure cannot prove that the copy completed.
      }
      if (priorCopyConfirmed) return;
      if (error instanceof BlobPreconditionFailedError) throw new Error("STORAGE_PRECONDITION_FAILED");
      preserveStableError(error);
    }
    if (copied.pathname !== destinationPathname || !isPrivateBlobUrl(copied.url)) {
      throw new Error("STORAGE_VERSIONING_REQUIRED");
    }
  }

  async readPrefix(objectKey: string, maximumBytes: number) {
    const pathname = exactPathname(objectKey);
    const controller = new AbortController();
    try {
      const result = await this.sdk.get(pathname, {
        access: "private",
        useCache: false,
        token: this.configuration.token,
        headers: { Range: `bytes=0-${Math.max(0, maximumBytes - 1)}` },
        abortSignal: AbortSignal.any([controller.signal, this.timeoutSignal()]),
      });
      if (!result) throw new Error("STORAGE_OBJECT_MISSING");
      if (result.statusCode !== 200
        || result.blob.pathname !== pathname
        || !isPrivateBlobUrl(result.blob.url)) {
        throw new Error("STORAGE_BODY_INVALID");
      }
      return await collectBoundedBody(result.stream, maximumBytes, controller);
    } catch (error) {
      preserveStableError(error);
    }
  }

  async deleteObject(objectKey: string) {
    const pathname = exactPathname(objectKey);
    try {
      await this.sdk.del(pathname, {
        token: this.configuration.token,
        abortSignal: this.timeoutSignal(),
      });
    } catch (error) {
      preserveStableError(error);
    }
  }
}
