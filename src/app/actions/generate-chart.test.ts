import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as chartService from "../../server/chart-service";
import { generateChart } from "./generate-chart";

const checkChartGenerationRateLimit = vi.hoisted(() => vi.fn());

vi.mock("../../server/chart-generation-rate-limit", () => ({
  checkChartGenerationRateLimit,
}));

const validInput = {
  localDateTime: "2024-02-10T12:00:00",
  timeZone: "Etc/UTC",
  birthplace: { name: "Greenwich", latitude: 0, longitude: 0 },
  timePrecision: "exact" as const,
};

beforeEach(() => {
  checkChartGenerationRateLimit.mockReset();
  checkChartGenerationRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
});

afterEach(() => vi.restoreAllMocks());

describe("generateChart", () => {
  it("maps the server chart service result to a display-only view model", async () => {
    const result = await generateChart(validInput);

    expect(result).toMatchObject({
      ok: true,
      viewModel: {
        summary: { birthplace: { name: "Greenwich" } },
        pillars: [
          expect.objectContaining({ position: "year", displayValue: "甲辰" }),
          expect.objectContaining({ position: "month", displayValue: "丙寅" }),
          expect.objectContaining({ position: "day", displayValue: "甲辰" }),
          expect.objectContaining({ position: "hour", displayValue: "庚午" }),
        ],
        groups: [
          { id: "ten-gods" },
          { id: "elements" },
          { id: "basics" },
          { id: "relations" },
          { id: "shensha" },
          { id: "kyusei" },
        ],
      },
    });
  });

  it.each([
    {
      input: { ...validInput, birthplace: { ...validInput.birthplace, latitude: 91 } },
      stage: "input",
      code: "INVALID_COORDINATES",
    },
    {
      input: {
        ...validInput,
        localDateTime: "2024-03-10T02:30:00",
        timeZone: "America/New_York",
        birthplace: { name: "New York", latitude: 40.7128, longitude: -74.006 },
      },
      stage: "civil-time",
      code: "DST_GAP",
    },
    {
      input: { ...validInput, localDateTime: "0001-01-01T00:00:00" },
      stage: "calculation",
      code: "UNSUPPORTED_DATE_RANGE",
    },
  ])("returns a safe $code result", async ({ input, stage, code }) => {
    const result = await generateChart(input);

    expect(result).toMatchObject({
      ok: false,
      error: { stage, code, message: expect.any(String) },
    });
    expect(JSON.stringify(result)).not.toMatch(/stack|RangeError|Error:/);
  });

  it("contains unexpected failures without exposing exception details", async () => {
    vi.spyOn(chartService, "buildStaticChart").mockImplementationOnce(() => {
      throw new Error("secret-stack-marker");
    });

    const result = await generateChart(validInput);

    expect(result).toEqual({
      ok: false,
      error: {
        stage: "calculation",
        code: "GENERATION_UNAVAILABLE",
        message: "命盘暂时无法生成，请稍后重试。",
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-stack-marker");
  });

  it("returns a safe retryable result before calculation when rate limited", async () => {
    const serviceSpy = vi.spyOn(chartService, "buildStaticChart");
    checkChartGenerationRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAtMs: 60_000,
      retryAfterMs: 30_000,
    });

    await expect(generateChart(validInput)).resolves.toEqual({
      ok: false,
      error: {
        stage: "calculation",
        code: "RATE_LIMITED",
        message: "命盘生成请求过于频繁，请稍后重试。",
        retryable: true,
      },
    });
    expect(serviceSpy).not.toHaveBeenCalled();
  });
});
