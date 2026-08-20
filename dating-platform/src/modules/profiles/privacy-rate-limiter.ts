import { createHmac } from "node:crypto";

type RedisLike = { isOpen?: boolean; connect(): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> };

export class RedisPrivacyRateLimiter {
  private readonly client: RedisLike;
  constructor(client: unknown, private readonly options: { hmacKey: string; limit?: number; windowMs?: number }) {
    if (options.hmacKey.length < 32) throw new Error("PRIVACY_RATE_LIMIT_SECRET_INVALID");
    this.client = client as RedisLike;
  }
  async consume(input: { userId: string; key: "privacy.export" | "privacy.delete" | "notification.preferences" }) {
    if (!this.client.isOpen) await this.client.connect();
    const opaque = createHmac("sha256", this.options.hmacKey).update(input.userId).digest("base64url");
    const windowMs = this.options.windowMs ?? 86_400_000;
    const result = await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}",
      { keys: [`privacy:rate:${input.key}:${opaque}`], arguments: [String(windowMs)] });
    if (!Array.isArray(result) || result.length !== 2) throw new Error("PRIVACY_RATE_LIMIT_RESPONSE_INVALID");
    const count = Number(result[0]); const ttl = Number(result[1]);
    if (!Number.isSafeInteger(count) || !Number.isFinite(ttl)) throw new Error("PRIVACY_RATE_LIMIT_RESPONSE_INVALID");
    return count <= (this.options.limit ?? 3) ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.min(86_400, Math.ceil(ttl / 1_000))) };
  }
}
