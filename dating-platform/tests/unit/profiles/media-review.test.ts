// @vitest-environment node

import { beforeAll, describe, expect, it } from "vitest";

import {
  HttpsMediaReviewAdapter,
  InMemoryMediaReviewAdapter,
  MediaReviewRetryableError,
} from "@/modules/profiles/media-review-adapter";
import { inspectImage } from "@/workers/media-review-worker";
import { getProfileSharp } from "@/modules/profiles/sharp-runtime";

const sharp = getProfileSharp();

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

describe("bounded media inspection and provider boundary", () => {
  it("fails startup clearly when Next cannot provide its locked image runtime", () => {
    expect(() => getProfileSharp((() => { throw new Error("missing"); }) as never))
      .toThrow("IMAGE_PROCESSOR_UNAVAILABLE");
  });
  let fixtures: Record<"jpeg" | "png" | "webp", Uint8Array>;

  beforeAll(async () => {
    const source = sharp({ create: { width: 80, height: 60, channels: 3, background: "#b91c1c" } });
    fixtures = {
      jpeg: await source.clone().jpeg().toBuffer(),
      png: await source.clone().png().toBuffer(),
      webp: await source.clone().webp().toBuffer(),
    };
  });

  it("reads real JPEG, PNG, and WebP metadata with maintained parsing", async () => {
    await expect(inspectImage(fixtures.jpeg, "image/jpeg")).resolves.toEqual({ width: 80, height: 60 });
    await expect(inspectImage(fixtures.png, "image/png")).resolves.toEqual({ width: 80, height: 60 });
    await expect(inspectImage(fixtures.webp, "image/webp")).resolves.toEqual({ width: 80, height: 60 });
  });

  it("rejects truncated, fabricated, cross-MIME, oversized, and excessive-pixel input", async () => {
    await expect(inspectImage(fixtures.png.slice(0, 20), "image/png")).rejects.toThrow();
    await expect(inspectImage(png(80, 60), "image/png")).rejects.toThrow();
    await expect(inspectImage(fixtures.png, "image/jpeg")).rejects.toThrow("SIGNATURE_MIME_MISMATCH");
    await expect(inspectImage(new Uint8Array(10 * 1024 * 1024 + 1), "image/png")).rejects.toThrow("IMAGE_SIZE_EXCEEDED");
    await expect(inspectImage(fixtures.png, "image/png", 4_799)).rejects.toThrow("IMAGE_DIMENSIONS_EXCEEDED");
  });

  it("accepts inclusive provider approve/reject outcomes in memory", async () => {
    const adapter = new InMemoryMediaReviewAdapter([
      { outcome: "approved", provider: "test", version: "v1" },
      { outcome: "rejected", provider: "test", version: "v1", reasonCode: "CONTENT_UNSAFE" },
    ]);
    await expect(adapter.review({ objectKey: "key", mimeType: "image/png", bytes: png(1, 1), width: 1, height: 1 }))
      .resolves.toMatchObject({ outcome: "approved" });
    await expect(adapter.review({ objectKey: "key", mimeType: "image/png", bytes: png(1, 1), width: 1, height: 1 }))
      .resolves.toMatchObject({ outcome: "rejected", reasonCode: "CONTENT_UNSAFE" });
  });

  it("fails closed and retryably when the production provider is not configured", async () => {
    const adapter = new HttpsMediaReviewAdapter();
    await expect(adapter.review({ objectKey: "key", mimeType: "image/png", bytes: png(1, 1), width: 1, height: 1 }))
      .rejects.toBeInstanceOf(MediaReviewRetryableError);
  });

  it("enforces exact provider origins and refuses redirects", async () => {
    expect(() => new HttpsMediaReviewAdapter({
      endpoint: "https://review.example.test.evil/check",
      apiKey: "key",
      provider: "vendor",
      version: "v1",
      allowedOrigins: ["https://review.example.test"],
    })).toThrow("MEDIA_REVIEW_ORIGIN_DENIED");
    let redirectMode: RequestRedirect | undefined;
    const adapter = new HttpsMediaReviewAdapter({
      endpoint: "https://review.example.test/check",
      apiKey: "key",
      provider: "vendor",
      version: "v1",
      allowedOrigins: ["https://review.example.test"],
      fetchImplementation: async (_url, init) => {
        redirectMode = init?.redirect;
        return new Response(null, { status: 302, headers: { location: "https://evil.test" } });
      },
    });
    await expect(adapter.review({ objectKey: "opaque", mimeType: "image/png", bytes: fixtures.png, width: 80, height: 60 }))
      .rejects.toBeInstanceOf(MediaReviewRetryableError);
    expect(redirectMode).toBe("manual");
  });

  it("bounds provider time and response bytes without exposing raw responses", async () => {
    const timeoutAdapter = new HttpsMediaReviewAdapter({
      endpoint: "https://review.example.test/check",
      apiKey: "key",
      provider: "vendor",
      version: "v1",
      allowedOrigins: ["https://review.example.test"],
      timeoutMs: 5,
      fetchImplementation: async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("raw timeout details")));
      }),
    });
    await expect(timeoutAdapter.review({ objectKey: "opaque", mimeType: "image/png", bytes: fixtures.png, width: 80, height: 60 }))
      .rejects.toEqual(new MediaReviewRetryableError());

    const oversized = new HttpsMediaReviewAdapter({
      endpoint: "https://review.example.test/check",
      apiKey: "key",
      provider: "vendor",
      version: "v1",
      allowedOrigins: ["https://review.example.test"],
      maximumResponseBytes: 64,
      fetchImplementation: async () => new Response("x".repeat(65), { status: 200 }),
    });
    await expect(oversized.review({ objectKey: "opaque", mimeType: "image/png", bytes: fixtures.png, width: 80, height: 60 }))
      .rejects.toEqual(new MediaReviewRetryableError());
  });
});
