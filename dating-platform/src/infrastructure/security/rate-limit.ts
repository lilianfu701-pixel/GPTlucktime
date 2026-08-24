import { createHmac } from "node:crypto";

type RedisLike = {
  isOpen?: boolean;
  connect(): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

type OutagePolicy = "closed" | "memory";

export type RateLimitPolicy = {
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
  outagePolicy: OutagePolicy;
  fallbackCapacity: number;
  fallbackRefillIntervalMs: number;
};

export const RATE_LIMIT_BUCKETS = {
  login: { capacity: 5, refillTokens: 5, refillIntervalMs: 15 * 60_000,
    outagePolicy: "closed", fallbackCapacity: 0, fallbackRefillIntervalMs: 0 },
  verification: { capacity: 3, refillTokens: 3, refillIntervalMs: 60 * 60_000,
    outagePolicy: "closed", fallbackCapacity: 0, fallbackRefillIntervalMs: 0 },
  search: { capacity: 30, refillTokens: 30, refillIntervalMs: 60_000,
    outagePolicy: "memory", fallbackCapacity: 5, fallbackRefillIntervalMs: 60_000 },
  profileViews: { capacity: 120, refillTokens: 120, refillIntervalMs: 60_000,
    outagePolicy: "memory", fallbackCapacity: 10, fallbackRefillIntervalMs: 60_000 },
  likes: { capacity: 30, refillTokens: 30, refillIntervalMs: 60 * 60_000,
    outagePolicy: "closed", fallbackCapacity: 0, fallbackRefillIntervalMs: 0 },
  messages: { capacity: 60, refillTokens: 60, refillIntervalMs: 60_000,
    outagePolicy: "closed", fallbackCapacity: 0, fallbackRefillIntervalMs: 0 },
  reports: { capacity: 5, refillTokens: 5, refillIntervalMs: 60 * 60_000,
    outagePolicy: "closed", fallbackCapacity: 0, fallbackRefillIntervalMs: 0 },
  uploads: { capacity: 10, refillTokens: 10, refillIntervalMs: 60 * 60_000,
    outagePolicy: "closed", fallbackCapacity: 0, fallbackRefillIntervalMs: 0 },
  payments: { capacity: 5, refillTokens: 5, refillIntervalMs: 60_000,
    outagePolicy: "closed", fallbackCapacity: 0, fallbackRefillIntervalMs: 0 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitBucket = keyof typeof RATE_LIMIT_BUCKETS;

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  source: "redis" | "memory" | "fail-closed";
};

type LocalBucket = { tokens: number; updatedAt: number };

const TOKEN_BUCKET_SCRIPT = `
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local tokens = tonumber(state[1]) or capacity
local updated = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - updated) * refill_per_ms)
local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('PEXPIRE', KEYS[1], ARGV[5])
local retry_ms = 0
if allowed == 0 then retry_ms = math.ceil((cost - tokens) / refill_per_ms) end
return {allowed, math.floor(tokens), retry_ms}
`;

export class RedisTokenBucketRateLimiter {
  private readonly client: RedisLike;
  private readonly hmacKey: string;
  private readonly now: () => number;
  private readonly fallback = new Map<string, LocalBucket>();

  constructor(client: unknown, options: { hmacKey: string; now?: () => number }) {
    if (options.hmacKey.length < 32) throw new Error("RATE_LIMIT_HMAC_KEY_INVALID");
    this.client = client as RedisLike;
    this.hmacKey = options.hmacKey;
    this.now = options.now ?? Date.now;
  }

  async consume(input: {
    bucket: RateLimitBucket;
    identifier: string;
    cost?: number;
  }): Promise<RateLimitDecision> {
    const policy = RATE_LIMIT_BUCKETS[input.bucket];
    const cost = input.cost ?? 1;
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > policy.capacity) {
      throw new TypeError("RATE_LIMIT_COST_INVALID");
    }
    const opaqueIdentifier = createHmac("sha256", this.hmacKey)
      .update(input.identifier)
      .digest("base64url");
    const key = `rate:token-bucket:${input.bucket}:${opaqueIdentifier}`;

    try {
      if (!this.client.isOpen) await this.client.connect();
      const refillPerMs = policy.refillTokens / policy.refillIntervalMs;
      const expiryMs = Math.ceil((policy.capacity / refillPerMs) * 2);
      const result = await this.client.eval(TOKEN_BUCKET_SCRIPT, {
        keys: [key],
        arguments: [
          String(policy.capacity),
          String(refillPerMs),
          String(this.now()),
          String(cost),
          String(expiryMs),
        ],
      });
      return this.parseRedisDecision(result, policy.capacity);
    } catch {
      if (policy.outagePolicy === "closed") {
        return { allowed: false, remaining: 0, retryAfterSeconds: 1, source: "fail-closed" };
      }
      return this.consumeFallback(key, policy, cost);
    }
  }

  private parseRedisDecision(result: unknown, capacity: number): RateLimitDecision {
    if (!Array.isArray(result) || result.length !== 3) throw new Error("RATE_LIMIT_RESPONSE_INVALID");
    const allowedValue = Number(result[0]);
    const remaining = Number(result[1]);
    const retryMs = Number(result[2]);
    if (![0, 1].includes(allowedValue) || !Number.isSafeInteger(remaining)
      || remaining < 0 || remaining > capacity || !Number.isFinite(retryMs) || retryMs < 0) {
      throw new Error("RATE_LIMIT_RESPONSE_INVALID");
    }
    return {
      allowed: allowedValue === 1,
      remaining,
      retryAfterSeconds: allowedValue === 1 ? 0 : boundedRetrySeconds(retryMs),
      source: "redis",
    };
  }

  private consumeFallback(key: string, policy: RateLimitPolicy, cost: number): RateLimitDecision {
    const now = this.now();
    const existing = this.fallback.get(key);
    const elapsed = Math.max(0, now - (existing?.updatedAt ?? now));
    const refillPerMs = policy.fallbackCapacity / policy.fallbackRefillIntervalMs;
    const tokens = Math.min(policy.fallbackCapacity, (existing?.tokens ?? policy.fallbackCapacity)
      + elapsed * refillPerMs);
    const allowed = tokens >= cost;
    const remainingTokens = allowed ? tokens - cost : tokens;
    this.fallback.set(key, { tokens: remainingTokens, updatedAt: now });
    return {
      allowed,
      remaining: Math.floor(remainingTokens),
      retryAfterSeconds: allowed ? 0 : boundedRetrySeconds((cost - remainingTokens) / refillPerMs),
      source: "memory",
    };
  }
}

function boundedRetrySeconds(retryMs: number): number {
  return Math.max(1, Math.min(86_400, Math.ceil(retryMs / 1_000)));
}
