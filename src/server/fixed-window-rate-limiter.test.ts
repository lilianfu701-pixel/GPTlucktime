import { describe, expect, it } from "vitest";

import {
  clientKeyFromHeaders,
  createFixedWindowRateLimiter,
} from "./fixed-window-rate-limiter";

describe("createFixedWindowRateLimiter", () => {
  it("limits a key inside a fixed window", () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      maxEntries: 10,
    });

    expect(limiter.consume("client-a", 0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume("client-a", 10)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume("client-a", 20)).toMatchObject({
      allowed: false,
      retryAfterMs: 980,
    });
  });

  it("tracks different keys independently", () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      maxEntries: 10,
    });

    expect(limiter.consume("client-a", 0).allowed).toBe(true);
    expect(limiter.consume("client-b", 0).allowed).toBe(true);
    expect(limiter.consume("client-a", 1).allowed).toBe(false);
  });

  it("allows a key again after its window expires", () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      maxEntries: 10,
    });

    expect(limiter.consume("client-a", 0).allowed).toBe(true);
    expect(limiter.consume("client-a", 999).allowed).toBe(false);
    expect(limiter.consume("client-a", 1_000)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("stays bounded and evicts the oldest entry at capacity", () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 10_000,
      maxEntries: 2,
    });

    limiter.consume("client-a", 0);
    limiter.consume("client-b", 1);
    limiter.consume("client-c", 2);
    expect(limiter.size()).toBe(2);
    expect(limiter.consume("client-a", 3).allowed).toBe(true);
    expect(limiter.size()).toBe(2);
  });
});

describe("clientKeyFromHeaders", () => {
  it("prefers Vercel's trusted forwarded header", () => {
    const headers = new Headers({
      "x-vercel-forwarded-for": "203.0.113.8, 10.0.0.1",
      "x-forwarded-for": "198.51.100.4",
    });

    expect(clientKeyFromHeaders(headers)).toBe("203.0.113.8");
  });

  it("falls back to the first forwarded address and then anonymous", () => {
    expect(
      clientKeyFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.2" })),
    ).toBe("198.51.100.4");
    expect(clientKeyFromHeaders(new Headers())).toBe("anonymous");
  });
});
