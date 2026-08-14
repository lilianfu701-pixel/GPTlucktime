import { describe, expect, it, vi } from "vitest";

import { RedisBillingRateLimiter } from "@/modules/billing/billing-rate-limiter";

describe("RedisBillingRateLimiter", () => {
  it("uses shared Redis state with opaque user keys and bounded retry", async () => {
    const evalFn = vi.fn<(script: string, options: { keys: string[]; arguments: string[] }) => Promise<number[]>>(
      async () => [4, 59_500],
    );
    const client = { isOpen: true, connect: vi.fn(), eval: evalFn };
    const limiter = new RedisBillingRateLimiter(client, { hmacKey: "billing-rate-hmac-at-least-32-characters", limit: 3, windowMs: 60_000 });
    await expect(limiter.consume({ userId: "private-user-id", key: "billing.checkout" }))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
    const options = evalFn.mock.calls[0]![1];
    expect(JSON.stringify(options)).not.toContain("private-user-id");
    expect(options.keys[0]).toMatch(/^billing:rate:billing\.checkout:/u);
  });
});
