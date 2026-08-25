// @vitest-environment node

import {
  BlobNotFoundError,
  BlobPreconditionFailedError,
  type CopyBlobResult,
  type GetBlobResult,
  type HeadBlobResult,
  type IssuedSignedToken,
} from "@vercel/blob";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VercelBlobStorageAdapter,
  type VercelBlobSdk,
} from "@/modules/profiles/vercel-blob-storage";

const serverToken = "vercel_blob_rw_test_token_that_must_remain_server_only";

vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/db/client", () => ({ db: {} }));
const issuedToken: IssuedSignedToken = {
  delegationToken: "scoped-delegation-token",
  clientSigningToken: "short-lived-client-signing-token",
  validUntil: Date.parse("2026-08-05T12:10:00.000Z"),
};
const sourceHead: HeadBlobResult = {
  size: 4,
  uploadedAt: new Date("2026-08-05T12:00:00.000Z"),
  pathname: "profile-media/user/upload/photo.png",
  contentType: "image/png",
  contentDisposition: "inline; filename=\"photo.png\"",
  url: "https://store.private.blob.vercel-storage.com/profile-media/user/upload/photo.png",
  downloadUrl: "https://store.private.blob.vercel-storage.com/profile-media/user/upload/photo.png?download=1",
  cacheControl: "public, max-age=60",
  etag: '"abc123"',
};
const copyResult: CopyBlobResult = {
  url: "https://store.private.blob.vercel-storage.com/profile-review/user/photo.png",
  downloadUrl: "https://store.private.blob.vercel-storage.com/profile-review/user/photo.png?download=1",
  pathname: "profile-review/user/photo.png",
  contentType: "image/png",
  contentDisposition: "inline; filename=\"photo.png\"",
  etag: '"destination-etag"',
};
const destinationHead: HeadBlobResult = {
  ...sourceHead,
  pathname: "profile-review/user/photo.png",
  url: "https://store.private.blob.vercel-storage.com/profile-review/user/photo.png",
  downloadUrl: "https://store.private.blob.vercel-storage.com/profile-review/user/photo.png?download=1",
  etag: '"destination-etag"',
};

const streamResult = (chunks: Uint8Array[], pathname = sourceHead.pathname): GetBlobResult => ({
  statusCode: 200,
  stream: new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }),
  headers: new Headers({ "content-range": `bytes 0-${chunks.reduce((sum, chunk) => sum + chunk.length, 0) - 1}/*` }),
  blob: {
    url: `https://store.private.blob.vercel-storage.com/${pathname}`,
    downloadUrl: `https://store.private.blob.vercel-storage.com/${pathname}?download=1`,
    pathname,
    contentDisposition: "inline",
    cacheControl: "public, max-age=60",
    uploadedAt: new Date("2026-08-05T12:00:00.000Z"),
    etag: '"abc123"',
    contentType: "image/png",
    size: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  },
});

function sdkDouble() {
  return {
    issueSignedToken: vi.fn(async () => issuedToken),
    presignUrl: vi.fn(async () => ({
      presignedUrl: "https://blob.vercel-storage.com/upload?vercel-blob-signature=scoped",
    })),
    head: vi.fn<VercelBlobSdk["head"]>(async () => sourceHead),
    copy: vi.fn(async () => copyResult),
    get: vi.fn(async (...arguments_: Parameters<VercelBlobSdk["get"]>) => {
      void arguments_;
      return streamResult([new Uint8Array([1, 2, 3, 4])]);
    }),
    del: vi.fn(async () => undefined),
  } satisfies VercelBlobSdk;
}

const adapterWith = (sdk: VercelBlobSdk, requestTimeoutMs = 1_250) =>
  new VercelBlobStorageAdapter({ token: serverToken, requestTimeoutMs, sdk });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("VercelBlobStorageAdapter", () => {
  it("creates a private exact-path PUT URL with a maximum 600-second lifetime and upload constraints", async () => {
    const sdk = sdkDouble();
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const timeout = vi.spyOn(AbortSignal, "timeout");

    const url = await adapterWith(sdk).createPutUrl({
      objectKey: "profile-media/user/upload/photo.png",
      mimeType: "image/png",
      sizeBytes: 1_024,
      expiresInSeconds: 900,
    });

    expect(url).toBe("https://blob.vercel-storage.com/upload?vercel-blob-signature=scoped");
    expect(url).not.toContain(serverToken);
    expect(sdk.issueSignedToken).toHaveBeenCalledWith(expect.objectContaining({
      token: serverToken,
      pathname: "profile-media/user/upload/photo.png",
      operations: ["put"],
      validUntil: now + 600_000,
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: 1_024,
      abortSignal: expect.any(AbortSignal),
    }));
    expect(sdk.presignUrl).toHaveBeenCalledWith(issuedToken, {
      access: "private",
      operation: "put",
      pathname: "profile-media/user/upload/photo.png",
      validUntil: now + 600_000,
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: 1_024,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(timeout).toHaveBeenCalledWith(1_250);
  });

  it("maps exact-path private HEAD metadata and derives a stable version from the ETag", async () => {
    const sdk = sdkDouble();
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await expect(adapterWith(sdk).headObject(sourceHead.pathname)).resolves.toEqual({
      sizeBytes: 4,
      mimeType: "image/png",
      etag: '"abc123"',
      versionId: 'blob-etag:"abc123"',
    });
    expect(sdk.head).toHaveBeenCalledWith(sourceHead.pathname, {
      token: serverToken,
      abortSignal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(1_250);
  });

  it("maps missing objects to null and rejects incomplete or mismatched metadata", async () => {
    const sdk = sdkDouble();
    sdk.head.mockRejectedValueOnce(new BlobNotFoundError());
    await expect(adapterWith(sdk).headObject(sourceHead.pathname)).resolves.toBeNull();

    sdk.head.mockResolvedValueOnce({ ...sourceHead, etag: "" });
    await expect(adapterWith(sdk).headObject(sourceHead.pathname)).rejects.toThrow("STORAGE_VERSIONING_REQUIRED");

    sdk.head.mockResolvedValueOnce({ ...sourceHead, pathname: "different/object.png" });
    await expect(adapterWith(sdk).headObject(sourceHead.pathname)).rejects.toThrow("STORAGE_VERSIONING_REQUIRED");
  });

  it("rejects HEAD metadata from a public Blob store", async () => {
    const sdk = sdkDouble();
    sdk.head.mockResolvedValueOnce({
      ...sourceHead,
      url: "https://store.public.blob.vercel-storage.com/profile-media/user/upload/photo.png",
    });
    await expect(adapterWith(sdk).headObject(sourceHead.pathname))
      .rejects.toThrow("STORAGE_VERSIONING_REQUIRED");
  });

  it("copies exact pathnames privately with source ETag concurrency and preserved MIME metadata", async () => {
    const sdk = sdkDouble();
    sdk.head
      .mockResolvedValueOnce(sourceHead)
      .mockRejectedValueOnce(new BlobNotFoundError());
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await adapterWith(sdk).copyObject(sourceHead.pathname, "profile-review/user/photo.png", {
      sourceETag: '"abc123"',
      sourceVersionId: 'blob-etag:"abc123"',
    });

    expect(sdk.head).toHaveBeenCalledWith(sourceHead.pathname, expect.objectContaining({ token: serverToken }));
    expect(sdk.copy).toHaveBeenCalledWith(sourceHead.pathname, "profile-review/user/photo.png", {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "image/png",
      ifMatch: '"abc123"',
      token: serverToken,
      abortSignal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledTimes(3);
  });

  it("never accepts a source ETag that is already stale", async () => {
    const sdk = sdkDouble();
    sdk.head.mockResolvedValueOnce({ ...sourceHead, etag: '"newer-etag"' });
    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, "profile-review/user/photo.png", {
      sourceETag: '"stale-etag"',
    })).rejects.toThrow("STORAGE_PRECONDITION_FAILED");
    expect(sdk.copy).not.toHaveBeenCalled();
  });

  it("rejects a real source precondition race when the source changed", async () => {
    const sdk = sdkDouble();
    sdk.head
      .mockResolvedValueOnce(sourceHead)
      .mockRejectedValueOnce(new BlobNotFoundError())
      .mockResolvedValueOnce({ ...sourceHead, etag: '"newer-etag"' });
    sdk.copy.mockRejectedValueOnce(new BlobPreconditionFailedError());

    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, "profile-review/user/photo.png", {
      sourceETag: '"abc123"',
    })).rejects.toThrow("STORAGE_PRECONDITION_FAILED");
  });

  it("reuses a prior deterministic copy without asking Blob to overwrite it", async () => {
    const sdk = sdkDouble();
    let destination: HeadBlobResult | null = null;
    sdk.head.mockImplementation(async (pathname) => {
      if (pathname === sourceHead.pathname) return sourceHead;
      if (pathname === destinationHead.pathname) {
        if (!destination) throw new BlobNotFoundError();
        return destination;
      }
      throw new BlobNotFoundError();
    });
    sdk.copy.mockImplementation(async () => {
      destination = destinationHead;
      return copyResult;
    });

    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, destinationHead.pathname, {
      sourceETag: '"abc123"',
    })).resolves.toBeUndefined();
    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, destinationHead.pathname, {
      sourceETag: '"abc123"',
    })).resolves.toBeUndefined();
    expect(sdk.copy).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a pre-existing destination after the bound source changed", async () => {
    const sdk = sdkDouble();
    sdk.head
      .mockResolvedValueOnce(sourceHead)
      .mockResolvedValueOnce(destinationHead)
      .mockResolvedValueOnce({ ...sourceHead, etag: '"changed-source"' });

    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, destinationHead.pathname, {
      sourceETag: '"abc123"',
    })).rejects.toThrow("STORAGE_PRECONDITION_FAILED");
    expect(sdk.copy).not.toHaveBeenCalled();
  });

  it.each([
    ["size", { ...destinationHead, size: destinationHead.size + 1 }],
    ["MIME", { ...destinationHead, contentType: "image/jpeg" }],
  ])("rejects a pre-existing destination whose %s differs", async (_field, destination) => {
    const sdk = sdkDouble();
    sdk.head
      .mockResolvedValueOnce(sourceHead)
      .mockResolvedValueOnce(destination);

    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, destinationHead.pathname, {
      sourceETag: '"abc123"',
    })).rejects.toThrow("STORAGE_PRECONDITION_FAILED");
    expect(sdk.copy).not.toHaveBeenCalled();
  });

  it("does not copy when the destination HEAD has an uncertain provider failure", async () => {
    const sdk = sdkDouble();
    sdk.head
      .mockResolvedValueOnce(sourceHead)
      .mockRejectedValueOnce(new Error("destination head failed"));

    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, destinationHead.pathname, {
      sourceETag: '"abc123"',
    })).rejects.toThrow("STORAGE_UNAVAILABLE");
    expect(sdk.copy).not.toHaveBeenCalled();
  });

  it("preserves an uncertain copy failure when no matching destination can be proven", async () => {
    const sdk = sdkDouble();
    sdk.head
      .mockResolvedValueOnce(sourceHead)
      .mockRejectedValueOnce(new BlobNotFoundError())
      .mockResolvedValueOnce(sourceHead)
      .mockRejectedValueOnce(new BlobNotFoundError());
    sdk.copy.mockRejectedValueOnce(new Error("uncertain provider failure"));

    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, destinationHead.pathname, {
      sourceETag: '"abc123"',
    })).rejects.toThrow("STORAGE_UNAVAILABLE");
    expect(sdk.head).toHaveBeenCalledTimes(4);
  });

  it("recovers an ambiguous copy failure only after proving the exact private destination", async () => {
    const sdk = sdkDouble();
    let destination: HeadBlobResult | null = null;
    sdk.head.mockImplementation(async (pathname) => {
      if (pathname === sourceHead.pathname) return sourceHead;
      if (pathname === destinationHead.pathname) {
        if (!destination) throw new BlobNotFoundError();
        return destination;
      }
      throw new BlobNotFoundError();
    });
    sdk.copy.mockImplementationOnce(async () => {
      destination = destinationHead;
      throw new Error("timeout after the provider completed the copy");
    });

    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, destinationHead.pathname, {
      sourceETag: '"abc123"',
    })).resolves.toBeUndefined();
    expect(sdk.copy).toHaveBeenCalledTimes(1);
  });

  it("rejects a copy result that is not the exact private destination", async () => {
    const sdk = sdkDouble();
    sdk.head
      .mockResolvedValueOnce(sourceHead)
      .mockRejectedValueOnce(new BlobNotFoundError());
    sdk.copy.mockResolvedValueOnce({
      ...copyResult,
      url: "https://store.public.blob.vercel-storage.com/profile-review/user/photo.png",
    });
    await expect(adapterWith(sdk).copyObject(sourceHead.pathname, "profile-review/user/photo.png", {
      sourceETag: '"abc123"',
    })).rejects.toThrow("STORAGE_VERSIONING_REQUIRED");
  });

  it("reads a private exact pathname with a capped Range and a bounded stream", async () => {
    const sdk = sdkDouble();
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await expect(adapterWith(sdk).readPrefix(sourceHead.pathname, 4))
      .resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(sdk.get).toHaveBeenCalledWith(sourceHead.pathname, {
      access: "private",
      useCache: false,
      token: serverToken,
      headers: { Range: "bytes=0-3" },
      abortSignal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(1_250);
  });

  it("aborts and rejects when a provider returns more than the requested prefix", async () => {
    const sdk = sdkDouble();
    sdk.get.mockResolvedValueOnce(streamResult([
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6]),
    ]));

    await expect(adapterWith(sdk).readPrefix(sourceHead.pathname, 5))
      .rejects.toThrow("STORAGE_OBJECT_TOO_LARGE");
    const signal = sdk.get.mock.calls[0]![1].abortSignal;
    expect(signal?.aborted).toBe(true);
  });

  it("rejects a private read response that resolves to a public Blob URL", async () => {
    const sdk = sdkDouble();
    const result = streamResult([new Uint8Array([1, 2, 3, 4])]);
    if (result.statusCode !== 200) throw new Error("invalid fixture");
    sdk.get.mockResolvedValueOnce({
      ...result,
      blob: {
        ...result.blob,
        url: "https://store.public.blob.vercel-storage.com/profile-media/user/upload/photo.png",
      },
    });
    await expect(adapterWith(sdk).readPrefix(sourceHead.pathname, 4))
      .rejects.toThrow("STORAGE_BODY_INVALID");
  });

  it("deletes only the exact pathname using the server token and a timeout", async () => {
    const sdk = sdkDouble();
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await adapterWith(sdk).deleteObject("profile-media/user/upload/photo.png");

    expect(sdk.del).toHaveBeenCalledWith("profile-media/user/upload/photo.png", {
      token: serverToken,
      abortSignal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(1_250);
  });

  it("maps provider details and timeouts to a stable error without leaking the server token", async () => {
    const sdk = sdkDouble();
    sdk.issueSignedToken.mockRejectedValueOnce(new Error(`provider failed with ${serverToken}`));

    const error = await adapterWith(sdk).createPutUrl({
      objectKey: sourceHead.pathname,
      mimeType: "image/png",
      sizeBytes: 4,
      expiresInSeconds: 300,
    }).catch((failure: unknown) => failure);

    expect(error).toEqual(new Error("STORAGE_UNAVAILABLE"));
    expect(String(error)).not.toContain(serverToken);
  });

  it("rejects URLs and unscoped pathnames before invoking the provider", async () => {
    const sdk = sdkDouble();
    await expect(adapterWith(sdk).headObject("https://public.example/photo.png"))
      .rejects.toThrow("STORAGE_PATH_INVALID");
    expect(sdk.head).not.toHaveBeenCalled();
  });

  it.each(["%2e%2e", "%2E%2e", "%2f", "%2F", "\u0000", "\u001f", "\u007f"])(
    "rejects encoded or control pathname segment %j before invoking the provider",
    async (unsafeSegment) => {
      const sdk = sdkDouble();
      await expect(adapterWith(sdk).headObject(`profile-media/user/${unsafeSegment}/photo.png`))
        .rejects.toThrow("STORAGE_PATH_INVALID");
      expect(sdk.head).not.toHaveBeenCalled();
    },
  );
});

const stubRuntimeEnvironment = (overrides: Record<string, string>) => {
  const values = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://app:secret@localhost:5432/dating_platform",
    REDIS_URL: "redis://:secret@localhost:6379",
    BETTER_AUTH_SECRET: "a-secure-development-secret-value",
    BETTER_AUTH_URL: "http://localhost:3000/api/auth",
    APP_URL: "http://localhost:3000",
    BLOB_READ_WRITE_TOKEN: "",
    PROFILE_MEDIA_STORAGE_ENDPOINT: "",
    PROFILE_MEDIA_STORAGE_REGION: "",
    PROFILE_MEDIA_STORAGE_BUCKET: "",
    PROFILE_MEDIA_STORAGE_ACCESS_KEY: "",
    PROFILE_MEDIA_STORAGE_SECRET_KEY: "",
    PROFILE_MEDIA_TOKEN_SECRET: "",
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
};

describe("profile media runtime storage selection", () => {
  it("selects Vercel Blob when its server-only token is configured", async () => {
    stubRuntimeEnvironment({
      BLOB_READ_WRITE_TOKEN: serverToken,
      PROFILE_MEDIA_TOKEN_SECRET: "profile-media-token-secret-at-least-32-characters",
    });

    const runtime = await import("@/modules/profiles/media-runtime");
    expect(runtime.profileMediaStorage?.constructor.name).toBe("VercelBlobStorageAdapter");
  });

  it("keeps the complete S3 backend selection and otherwise selects null", async () => {
    stubRuntimeEnvironment({
      PROFILE_MEDIA_STORAGE_ENDPOINT: "https://storage.example.test",
      PROFILE_MEDIA_STORAGE_REGION: "us-west-2",
      PROFILE_MEDIA_STORAGE_BUCKET: "profile-media",
      PROFILE_MEDIA_STORAGE_ACCESS_KEY: "storage-access",
      PROFILE_MEDIA_STORAGE_SECRET_KEY: "storage-secret",
      PROFILE_MEDIA_TOKEN_SECRET: "profile-media-token-secret-at-least-32-characters",
    });
    let runtime = await import("@/modules/profiles/media-runtime");
    expect(runtime.profileMediaStorage?.constructor.name).toBe("S3StorageAdapter");

    vi.resetModules();
    vi.unstubAllEnvs();
    stubRuntimeEnvironment({});
    runtime = await import("@/modules/profiles/media-runtime");
    expect(runtime.profileMediaStorage).toBeNull();
  });
});
