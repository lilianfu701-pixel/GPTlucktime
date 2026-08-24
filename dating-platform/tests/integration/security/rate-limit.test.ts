import { describe, expect, it, vi } from "vitest";

import {
  RATE_LIMIT_BUCKETS,
  RedisTokenBucketRateLimiter,
} from "@/infrastructure/security/rate-limit";

describe("RedisTokenBucketRateLimiter", () => {
  it("defines every required endpoint bucket", () => {
    expect(Object.keys(RATE_LIMIT_BUCKETS)).toEqual([
      "login",
      "verification",
      "search",
      "profileViews",
      "likes",
      "messages",
      "reports",
      "uploads",
      "payments",
    ]);
  });

  it("uses atomic Redis token buckets with opaque actor keys", async () => {
    const evalFn = vi.fn<(
      script: string,
      options: { keys: string[]; arguments: string[] },
    ) => Promise<number[]>>(async () => [1, 2, 0]);
    const limiter = new RedisTokenBucketRateLimiter({
      isOpen: true,
      connect: vi.fn(),
      eval: evalFn,
    }, {
      hmacKey: "task-14-rate-limit-secret-at-least-32-characters",
      now: () => 987_654_321,
    });

    await expect(limiter.consume({ bucket: "login", identifier: "person@example.test" }))
      .resolves.toMatchObject({ allowed: true, remaining: 2, source: "redis" });

    const [script, options] = evalFn.mock.calls[0]!;
    expect(script).toContain("HMGET");
    expect(script).toContain("redis.call('TIME')");
    expect(options.arguments).toHaveLength(4);
    expect(options.arguments).not.toContain("987654321");
    expect(JSON.stringify(options)).not.toContain("person@example.test");
    expect(options.keys[0]).toMatch(/^rate:token-bucket:login:/u);
  });

  it.each(["login", "verification", "payments"] as const)(
    "fails closed for %s when Redis is unavailable",
    async (bucket) => {
      const limiter = new RedisTokenBucketRateLimiter({
        isOpen: true,
        connect: vi.fn(),
        eval: vi.fn(async () => { throw new Error("redis unavailable"); }),
      }, { hmacKey: "task-14-rate-limit-secret-at-least-32-characters" });

      await expect(limiter.consume({ bucket, identifier: "actor-1" })).resolves.toMatchObject({
        allowed: false,
        remaining: 0,
        source: "fail-closed",
      });
    },
  );

  it.each(["search", "profileViews"] as const)(
    "uses a conservative in-process fallback for %s during a Redis outage",
    async (bucket) => {
      const limiter = new RedisTokenBucketRateLimiter({
        isOpen: true,
        connect: vi.fn(),
        eval: vi.fn(async () => { throw new Error("redis unavailable"); }),
      }, {
        hmacKey: "task-14-rate-limit-secret-at-least-32-characters",
        now: () => 1_000,
      });

      const policy = RATE_LIMIT_BUCKETS[bucket];
      for (let index = 0; index < policy.fallbackCapacity; index += 1) {
        await expect(limiter.consume({ bucket, identifier: "browser-1" }))
          .resolves.toMatchObject({ allowed: true, source: "memory" });
      }
      await expect(limiter.consume({ bucket, identifier: "browser-1" })).resolves.toMatchObject({
        allowed: false,
        remaining: 0,
        source: "memory",
      });
    },
  );

  it("bounds fallback cardinality with LRU eviction and never stores raw identifiers", async () => {
    const evalFn = vi.fn(async () => { throw new Error("redis unavailable"); });
    const options = {
      hmacKey: "task-14-rate-limit-secret-at-least-32-characters",
      fallbackMaxEntries: 2,
      now: () => 1_000,
    };
    const limiter = new RedisTokenBucketRateLimiter({
      isOpen: true,
      connect: vi.fn(),
      eval: evalFn,
    }, options);

    await limiter.consume({ bucket: "search", identifier: "raw-actor-1@example.test" });
    await limiter.consume({ bucket: "search", identifier: "raw-actor-2@example.test" });
    await limiter.consume({ bucket: "search", identifier: "raw-actor-1@example.test" });
    await limiter.consume({ bucket: "search", identifier: "raw-actor-3@example.test" });
    await expect(limiter.consume({ bucket: "search", identifier: "raw-actor-2@example.test" }))
      .resolves.toMatchObject({ allowed: true, remaining: 4, source: "memory" });
    expect(JSON.stringify(evalFn.mock.calls)).not.toContain("raw-actor");
  });

  it("expires fallback state and clears it after Redis recovers", async () => {
    let now = 1_000;
    const evalFn = vi.fn()
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce([1, 20, 0])
      .mockRejectedValue(new Error("redis unavailable"));
    const options = {
      hmacKey: "task-14-rate-limit-secret-at-least-32-characters",
      fallbackStateTtlMs: 1_000,
      now: () => now,
    };
    const limiter = new RedisTokenBucketRateLimiter({ isOpen: true, connect: vi.fn(), eval: evalFn }, options);

    await limiter.consume({ bucket: "search", identifier: "browser-1" });
    await limiter.consume({ bucket: "search", identifier: "browser-1" });
    now += 1_001;
    await expect(limiter.consume({ bucket: "search", identifier: "browser-1" }))
      .resolves.toMatchObject({ remaining: 4, source: "memory" });
    await expect(limiter.consume({ bucket: "search", identifier: "browser-1" }))
      .resolves.toMatchObject({ remaining: 20, source: "redis" });
    await expect(limiter.consume({ bucket: "search", identifier: "browser-1" }))
      .resolves.toMatchObject({ remaining: 4, source: "memory" });
  });

  it("rejects empty and excessively large identifiers before storage access", async () => {
    const evalFn = vi.fn(async () => [1, 1, 0]);
    const limiter = new RedisTokenBucketRateLimiter({ isOpen: true, connect: vi.fn(), eval: evalFn }, {
      hmacKey: "task-14-rate-limit-secret-at-least-32-characters",
    });

    await expect(limiter.consume({ bucket: "search", identifier: "" }))
      .rejects.toThrow("RATE_LIMIT_IDENTIFIER_INVALID");
    await expect(limiter.consume({ bucket: "search", identifier: "x".repeat(513) }))
      .rejects.toThrow("RATE_LIMIT_IDENTIFIER_INVALID");
    expect(evalFn).not.toHaveBeenCalled();
  });
});
