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

let configured: MediaStorage | null = null;

/**
 * The configured adapter.
 *
 * An S3-compatible adapter is not wired yet; until a provider is chosen this
 * returns the in-memory one. It throws in production rather than silently
 * accepting a family's photographs into a store that forgets them on restart.
 */
export function mediaStorage(): MediaStorage {
  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No object storage adapter is configured. Media uploads are unavailable " +
        "until an S3-compatible provider is selected and wired.",
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
