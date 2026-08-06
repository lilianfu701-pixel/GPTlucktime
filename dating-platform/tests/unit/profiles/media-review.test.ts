// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  HttpsMediaReviewAdapter,
  InMemoryMediaReviewAdapter,
  MediaReviewRetryableError,
} from "@/modules/profiles/media-review-adapter";
import { inspectImage } from "@/workers/media-review-worker";

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

describe("bounded media inspection and provider boundary", () => {
  it("validates magic bytes and bounded image dimensions", () => {
    expect(inspectImage(png(800, 600), "image/png")).toEqual({ width: 800, height: 600 });
    expect(() => inspectImage(png(800, 600), "image/jpeg")).toThrow("SIGNATURE_MIME_MISMATCH");
    expect(() => inspectImage(png(20_000, 20_000), "image/png")).toThrow("IMAGE_DIMENSIONS_EXCEEDED");
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
});
