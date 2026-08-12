import { createHmac } from "node:crypto";

import type { ReportRateLimiter } from "./report-route";

type RedisLike = {
  isOpen?: boolean;
  connect(): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

export class RedisReportRateLimiter implements ReportRateLimiter {
  private readonly client: RedisLike;
  private readonly hmacKey: string;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(client: unknown, options: {
    hmacKey: string;
    limit?: number;
    windowMs?: number;
  }) {
    if (options.hmacKey.length < 16) throw new Error("REPORT_RATE_LIMIT_HMAC_KEY_TOO_SHORT");
    this.client = client as RedisLike;
    this.hmacKey = options.hmacKey;
    this.limit = options.limit ?? 10;
    this.windowMs = options.windowMs ?? 60 * 60_000;
    if (!Number.isInteger(this.limit) || this.limit < 1
      || !Number.isInteger(this.windowMs) || this.windowMs < 1_000) {
      throw new Error("INVALID_REPORT_RATE_LIMIT_CONFIGURATION");
    }
  }

  async consume(input: { userId: string; key: "report.submit" }) {
    if (!this.client.isOpen) await this.client.connect();
    const digest = createHmac("sha256", this.hmacKey).update(input.userId).digest("base64url");
    const key = `moderation:rate:${input.key}:${digest}`;
    const result = await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}",
      { keys: [key], arguments: [String(this.windowMs)] },
    );
    if (!Array.isArray(result) || result.length !== 2) throw new Error("REPORT_RATE_LIMIT_INVALID_RESPONSE");
    const count = Number(result[0]);
    const ttlMs = Number(result[1]);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttlMs)) {
      throw new Error("REPORT_RATE_LIMIT_INVALID_RESPONSE");
    }
    return count <= this.limit
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
  }
}
