import { createHash } from "node:crypto";

export type MediaReviewInput = {
  objectKey: string;
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
};

export type MediaReviewDecision =
  | { outcome: "approved"; provider: string; version: string }
  | { outcome: "rejected"; provider: string; version: string; reasonCode: string };

export interface MediaReviewAdapter {
  review(input: MediaReviewInput): Promise<MediaReviewDecision>;
}

export class MediaReviewRetryableError extends Error {
  constructor() { super("MEDIA_REVIEW_PROVIDER_RETRY"); }
}

export class InMemoryMediaReviewAdapter implements MediaReviewAdapter {
  constructor(private readonly decisions: MediaReviewDecision[] = [
    { outcome: "approved", provider: "in-memory", version: "v1" },
  ]) {}

  async review(input: MediaReviewInput): Promise<MediaReviewDecision> {
    void input;
    const decision = this.decisions.shift();
    if (!decision) throw new MediaReviewRetryableError();
    return decision;
  }
}

export class HttpsMediaReviewAdapter implements MediaReviewAdapter {
  constructor(private readonly configuration?: {
    endpoint: string;
    apiKey: string;
    provider: string;
    version: string;
    fetchImplementation?: typeof fetch;
  }) {
    if (configuration) {
      const url = new URL(configuration.endpoint);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("MEDIA_REVIEW_URL_INVALID");
      }
    }
  }

  async review(input: MediaReviewInput): Promise<MediaReviewDecision> {
    if (!this.configuration) throw new MediaReviewRetryableError();
    const fetchImplementation = this.configuration.fetchImplementation ?? fetch;
    let response: Response;
    try {
      response = await fetchImplementation(this.configuration.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.configuration.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          objectKey: input.objectKey,
          mimeType: input.mimeType,
          byteLength: input.bytes.byteLength,
          sha256: createHash("sha256").update(input.bytes).digest("hex"),
          contentBase64: Buffer.from(input.bytes).toString("base64"),
          width: input.width,
          height: input.height,
          checks: ["malware", "content", "liveness"],
        }),
      });
    } catch {
      throw new MediaReviewRetryableError();
    }
    if (!response.ok) throw new MediaReviewRetryableError();
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new MediaReviewRetryableError(); }
    if (!raw || typeof raw !== "object") throw new MediaReviewRetryableError();
    const result = raw as Record<string, unknown>;
    if (![result.malwareSafe, result.contentSafe, result.liveSubject]
      .every((value) => typeof value === "boolean")) {
      throw new MediaReviewRetryableError();
    }
    if ([result.malwareSafe, result.contentSafe, result.liveSubject].some((value) => value !== true)) {
      const reasonCode = result.malwareSafe === false
        ? "MALWARE_DETECTED"
        : result.liveSubject === false ? "LIVENESS_FAILED" : "CONTENT_UNSAFE";
      return {
        outcome: "rejected",
        provider: this.configuration.provider,
        version: this.configuration.version,
        reasonCode,
      };
    }
    return {
      outcome: "approved",
      provider: this.configuration.provider,
      version: this.configuration.version,
    };
  }
}
