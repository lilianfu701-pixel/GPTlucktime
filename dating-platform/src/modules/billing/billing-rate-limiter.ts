import { createHmac } from "node:crypto";

type RedisLike = {
  isOpen?: boolean;
  connect(): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

export class RedisBillingRateLimiter {
  private readonly client: RedisLike;
  private readonly hmacKey: string;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(client: unknown, options: { hmacKey: string; limit?: number; windowMs?: number }) {
    if (options.hmacKey.length < 32) throw new Error("BILLING_RATE_LIMIT_SECRET_INVALID");
    this.client = client as RedisLike;
    this.hmacKey = options.hmacKey;
    this.limit = options.limit ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    if (!Number.isInteger(this.limit) || this.limit < 1 || !Number.isInteger(this.windowMs) || this.windowMs < 1_000) {
      throw new Error("BILLING_RATE_LIMIT_CONFIGURATION_INVALID");
    }
  }

  async consume(input: { userId: string; key: "billing.checkout" | "billing.subscription.manage" }) {
    if (!this.client.isOpen) await this.client.connect();
    const digest = createHmac("sha256", this.hmacKey).update(input.userId).digest("base64url");
    const result = await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}",
      { keys: [`billing:rate:${input.key}:${digest}`], arguments: [String(this.windowMs)] },
    );
    if (!Array.isArray(result) || result.length !== 2) throw new Error("BILLING_RATE_LIMIT_RESPONSE_INVALID");
    const count = Number(result[0]);
    const ttlMs = Number(result[1]);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttlMs)) throw new Error("BILLING_RATE_LIMIT_RESPONSE_INVALID");
    return count <= this.limit ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.min(86_400, Math.ceil(ttlMs / 1_000))) };
  }
}
