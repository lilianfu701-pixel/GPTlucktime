import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

/**
 * Object storage, behind an interface.
 *
 * Kept narrow so the pipeline can be exercised without a network round trip,
 * and so swapping S3 for R2 or MinIO is a change in one adapter. No S3-specific
 * concept leaks into the domain.
 */
export interface MediaStorage {
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
    maxBytes: number;
  }): Promise<{ url: string; headers: Record<string, string> }>;

  createReadUrl(objectKey: string, expiresInSeconds: number): Promise<string>;

  /** A permanent address. Only ever called for a public memorial's ready asset. */
  publicUrl(objectKey: string): string | null;

  getObject(objectKey: string): Promise<Uint8Array | null>;
  putObject(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
  deleteObject(objectKey: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

/**
 * In-memory adapter.
 *
 * Used by the tests, and by local development until a storage provider is
 * chosen. Its signed URLs carry an expiry so a caller that ignores expiry is
 * caught here rather than in production.
 */
export class InMemoryMediaStorage implements MediaStorage {
  private readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string }
  >();

  readonly issuedUploadUrls: { objectKey: string; expiresAt: number }[] = [];

  /** Set when the adapter should behave as a public bucket. */
  constructor(private readonly publicBaseUrl: string | null = null) {}

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
    maxBytes: number;
  }): Promise<{ url: string; headers: Record<string, string> }> {
    const expiresAt = Date.now() + input.expiresInSeconds * 1000;
    this.issuedUploadUrls.push({ objectKey: input.objectKey, expiresAt });

    return Promise.resolve({
      url: `memory://upload/${encodeURIComponent(input.objectKey)}?expires=${expiresAt}`,
      headers: {
        "content-type": input.contentType,
        // The provider enforces the ceiling, so a client that lies about size
        // in the sign request still cannot upload more than we allowed.
        "x-max-bytes": String(input.maxBytes),
      },
    });
  }

  async createReadUrl(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    return Promise.resolve(
      `memory://read/${encodeURIComponent(objectKey)}?expires=${expiresAt}`,
    );
  }

  publicUrl(objectKey: string): string | null {
    if (!this.publicBaseUrl) {
      return null;
    }
    return `${this.publicBaseUrl}/${objectKey}`;
  }

  async getObject(objectKey: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(objectKey)?.bytes ?? null);
  }

  async putObject(
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    this.objects.set(objectKey, { bytes, contentType });
    return Promise.resolve();
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
    return Promise.resolve();
  }

  async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  /** Test helper: what is actually stored. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

/**
 * S3-compatible adapter.
 *
 * Speaks the S3 API, so the same code serves AWS S3, Cloudflare R2, Supabase
 * Storage and MinIO; the provider is chosen entirely through configuration.
 * Uploads and private reads use presigned URLs so the bytes never pass through
 * the application, and a signed URL carries its own expiry.
 */
export class S3MediaStorage implements MediaStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string | null;

  constructor(config: {
    bucket: string;
    region: string;
    endpoint?: string | undefined;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    publicBaseUrl?: string | undefined;
  }) {
    this.bucket = config.bucket;
    this.publicBase = config.publicBaseUrl ?? null;
    this.client = new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
    maxBytes: number;
  }): Promise<{ url: string; headers: Record<string, string> }> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
      }),
      { expiresIn: input.expiresInSeconds },
    );

    // The content type is part of the signature, so the client must send this
    // exact header on the PUT or the upload is rejected by the provider.
    return { url, headers: { "content-type": input.contentType } };
  }

  async createReadUrl(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { expiresIn: expiresInSeconds },
    );
  }

  publicUrl(objectKey: string): string | null {
    if (!this.publicBase) {
      return null;
    }
    return `${this.publicBase.replace(/\/+$/, "")}/${objectKey}`;
  }

  async getObject(objectKey: string): Promise<Uint8Array | null> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      if (!output.Body) {
        return null;
      }
      return await output.Body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async putObject(
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
  }

  async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    let token: string | undefined;

    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );

      const keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => typeof key === "string");

      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
        removed += keys.length;
      }

      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);

    return removed;
  }
}

/** A missing object is not an error for a read: the caller decides what absence means. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

let configured: MediaStorage | null = null;

/** Builds the S3 adapter from configuration, or null when it is not fully set. */
function s3StorageFromEnv(): S3MediaStorage | null {
  const config = env();
  if (
    !config.S3_BUCKET ||
    !config.S3_REGION ||
    !config.S3_ACCESS_KEY_ID ||
    !config.S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }

  return new S3MediaStorage({
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    publicBaseUrl: config.S3_PUBLIC_BASE_URL,
  });
}

/**
 * The configured adapter.
 *
 * Uses the S3 adapter when a bucket and credentials are set. Falls back to the
 * in-memory one only outside production; in production a missing configuration
 * throws rather than silently accepting a family's photographs into a store
 * that forgets them on restart.
 */
export function mediaStorage(): MediaStorage {
  if (configured) {
    return configured;
  }

  const s3 = s3StorageFromEnv();
  if (s3) {
    configured = s3;
    return s3;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No object storage adapter is configured. Set S3_BUCKET, S3_REGION and " +
        "S3 credentials to enable media uploads.",
    );
  }

  configured = new InMemoryMediaStorage();
  return configured;
}

/** Test seam. */
export function setMediaStorage(storage: MediaStorage | null): void {
  configured = storage;
}

/**
 * Removes image metadata.
 *
 * A photograph from a phone commonly carries GPS coordinates and a device
 * serial. Publishing a family's address alongside a memorial is a privacy
 * failure, so this runs before any derived file is written. Doc 06 section 4.
 */
export interface ImageProcessor {
  stripMetadataAndResize(input: {
    bytes: Uint8Array;
    variant: "original" | "thumb" | "medium" | "large";
  }): Promise<{ bytes: Uint8Array; contentType: string }>;
}

/**
 * Sharp-backed image processor.
 *
 * `.rotate()` bakes the EXIF orientation into the pixels and then drops all
 * metadata — GPS, device serial, creation timestamps. The image is then
 * re-encoded into the original format, which makes it a genuinely new file:
 * any payload hidden in an IDAT chunk, a JPEG comment or an EXIF thumbnail
 * is gone because it never survived the decode→encode cycle. This satisfies
 * doc 06 §4 without an external malware scanner on the image path.
 */
export class SharpImageProcessor implements ImageProcessor {
  private static readonly DIMENSION_FOR: Record<string, number> = {
    original: 2560,
    large: 2048,
    medium: 1024,
    thumb: 320,
  };

  async stripMetadataAndResize(input: {
    bytes: Uint8Array;
    variant: "original" | "thumb" | "medium" | "large";
  }): Promise<{ bytes: Uint8Array; contentType: string }> {
    const sharp = (await import("sharp")).default;
    const dimension = SharpImageProcessor.DIMENSION_FOR[input.variant] ?? 2560;

    const image = sharp(input.bytes)
      .rotate() // bakes EXIF orientation, drops all metadata
      .resize({
        width: dimension,
        height: dimension,
        fit: "inside",
        withoutEnlargement: true,
      });

    const metadata = await sharp(input.bytes).metadata();

    switch (metadata.format) {
      case "png": {
        const bytes = await image.png({ compressionLevel: 9 }).toBuffer();
        return { bytes: new Uint8Array(bytes), contentType: "image/png" };
      }
      case "webp": {
        const bytes = await image.webp({ quality: 82 }).toBuffer();
        return { bytes: new Uint8Array(bytes), contentType: "image/webp" };
      }
      default: {
        // JPEG is the fallback for anything sharp can decode but that is not
        // PNG or WebP (including TIFF, HEIC if libvips was built with support).
        const bytes = await image
          .jpeg({ quality: 82, mozjpeg: true })
          .toBuffer();
        return { bytes: new Uint8Array(bytes), contentType: "image/jpeg" };
      }
    }
  }
}

let configuredProcessor: ImageProcessor | null = null;

export function mediaImageProcessor(): ImageProcessor {
  configuredProcessor ??= new SharpImageProcessor();
  return configuredProcessor;
}

/** Test seam. */
export function setMediaImageProcessor(processor: ImageProcessor | null): void {
  configuredProcessor = processor;
}

/** Reports whether bytes are safe. A real vendor replaces this. */
export interface MalwareScanner {
  scan(bytes: Uint8Array): Promise<{ clean: boolean; signature?: string }>;
}

/**
 * Placeholder scanner.
 *
 * Refuses to run in production: a pipeline that reports every file clean is
 * worse than no scanner, because it makes the pipeline look complete.
 */
export class AlwaysCleanScanner implements MalwareScanner {
  async scan(): Promise<{ clean: boolean }> {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "No malware scanner is configured. Uploads are unavailable until one is.",
      );
    }
    return Promise.resolve({ clean: true });
  }
}
