import { describe, expect, it } from "vitest";

import { RedisReportRateLimiter } from "@/modules/moderation/report-rate-limiter";

describe("RedisReportRateLimiter", () => {
  it("uses one shared persistent window without exposing the user id in the key", async () => {
    const keys: string[] = [];
    let count = 0;
    const limiter = new RedisReportRateLimiter({
      isOpen: true,
      connect: async () => undefined,
      eval: async (_script: string, options: { keys: string[]; arguments: string[] }) => {
        keys.push(options.keys[0]!);
        count += 1;
        return [count, 59_000];
      },
    }, { hmacKey: "rate-limit-test-secret", limit: 2, windowMs: 60_000 });
    const userId = "00000000-0000-4000-8000-000000000501";
    await expect(limiter.consume({ userId, key: "report.submit" }))
      .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(limiter.consume({ userId, key: "report.submit" }))
      .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(limiter.consume({ userId, key: "report.submit" }))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 59 });
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^moderation:rate:report\.submit:/u);
    expect(keys[0]).not.toContain(userId);
  });

  it("propagates storage outages so the report route fails closed", async () => {
    const limiter = new RedisReportRateLimiter({
      isOpen: true,
      connect: async () => undefined,
      eval: async () => { throw new Error("redis unavailable"); },
    }, { hmacKey: "rate-limit-test-secret" });
    await expect(limiter.consume({
      userId: "00000000-0000-4000-8000-000000000501",
      key: "report.submit",
    })).rejects.toThrow("redis unavailable");
  });
});
