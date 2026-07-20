import { beforeEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: headersMock }));

beforeEach(() => {
  vi.resetModules();
  headersMock.mockReset();
});

describe("checkChartGenerationRateLimit", () => {
  it("allows ten requests per trusted Vercel client key and rejects the eleventh", async () => {
    headersMock.mockResolvedValue({
      get: (name: string) =>
        name === "x-vercel-forwarded-for"
          ? "203.0.113.10, 10.0.0.1"
          : name === "x-forwarded-for"
            ? "198.51.100.20"
            : null,
    });
    const { checkChartGenerationRateLimit } = await import(
      "./chart-generation-rate-limit"
    );

    for (let request = 0; request < 10; request += 1) {
      await expect(checkChartGenerationRateLimit()).resolves.toMatchObject({
        allowed: true,
        remaining: 9 - request,
      });
    }
    await expect(checkChartGenerationRateLimit()).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterMs: expect.any(Number),
    });
  });
});
