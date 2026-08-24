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
    }, { hmacKey: "task-14-rate-limit-secret-at-least-32-characters" });

    await expect(limiter.consume({ bucket: "login", identifier: "person@example.test" }))
      .resolves.toMatchObject({ allowed: true, remaining: 2, source: "redis" });

    const [script, options] = evalFn.mock.calls[0]!;
    expect(script).toContain("HMGET");
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
});
