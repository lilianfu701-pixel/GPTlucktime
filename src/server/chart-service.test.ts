import { describe, expect, it } from "vitest";

import { buildStaticChart } from "./chart-service";

const validInput = {
  localDateTime: "2024-02-10T12:00:00",
  timeZone: "Etc/UTC",
  birthplace: {
    name: "Greenwich",
    latitude: 0,
    longitude: 0,
  },
  timePrecision: "exact" as const,
};

describe("buildStaticChart", () => {
  it("returns a successful immutable chart context", () => {
    const result = buildStaticChart(validInput);

    expect(result).toMatchObject({
      ok: true,
      chart: {
        input: validInput,
        pillars: {
          year: { stem: "甲", branch: "辰", index: 40 },
          month: { stem: "丙", branch: "寅", index: 2 },
        },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.chart)).toBe(true);
  });

  it("returns a safe invalid-coordinate error", () => {
    const result = buildStaticChart({
      ...validInput,
      birthplace: { ...validInput.birthplace, latitude: 91 },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        stage: "input",
        code: "INVALID_COORDINATES",
        message: "Latitude or longitude is out of range.",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/stack|RangeError|Error:/);
  });

  it.each([
    {
      localDateTime: "2024-03-10T02:30:00",
      code: "DST_GAP",
    },
    {
      localDateTime: "2024-11-03T01:30:00",
      code: "DST_AMBIGUOUS",
    },
  ])("returns a safe $code civil-time error", ({ localDateTime, code }) => {
    const result = buildStaticChart({
      ...validInput,
      localDateTime,
      timeZone: "America/New_York",
      birthplace: {
        name: "New York",
        latitude: 40.7128,
        longitude: -74.006,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { stage: "civil-time", code, message: expect.any(String) },
    });
    expect(JSON.stringify(result)).not.toMatch(/stack|RangeError|Error:/);
  });

  it("returns a safe unsupported-date error", () => {
    expect(
      buildStaticChart({ ...validInput, localDateTime: "0001-01-01T00:00:00" }),
    ).toEqual({
      ok: false,
      error: {
        stage: "calculation",
        code: "UNSUPPORTED_DATE_RANGE",
        message: "Static charts support true-solar years from 0002 through 9998.",
      },
    });
  });
});
