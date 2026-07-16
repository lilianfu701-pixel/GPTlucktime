import { describe, expect, it } from "vitest";

import { calculateSolarTime } from "./solar-time";

describe("calculateSolarTime", () => {
  it("applies four minutes per degree of longitude from the standard meridian", () => {
    const result = calculateSolarTime({
      utcIso: "2024-06-01T04:00:00.000Z",
      longitude: 121.5,
      standardMeridianLongitude: 120,
      birthplaceOffsetMinutes: 480,
    });

    expect(result.longitudeCorrectionSeconds).toBe(360);
    expect(typeof result.equationOfTimeSeconds).toBe("number");
    expect(result.trueSolarIso).toMatch(/\+08:00$/);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("matches an independent equation-of-time and true-solar-time reference", () => {
    const result = calculateSolarTime({
      utcIso: "2024-06-01T04:00:00.000Z",
      longitude: 121.5,
      standardMeridianLongitude: 120,
      birthplaceOffsetMinutes: 480,
    });

    expect(result.equationOfTimeSeconds).toBeCloseTo(127.38, 1);
    expect(result.trueSolarIso).toBe("2024-06-01T12:08:07.383+08:00");
  });

  it.each([90.5, 1440])(
    "rejects an unformattable birthplace offset (%s)",
    (birthplaceOffsetMinutes) => {
      expect(() =>
        calculateSolarTime({
          utcIso: "2024-06-01T04:00:00.000Z",
          longitude: 121.5,
          standardMeridianLongitude: 120,
          birthplaceOffsetMinutes,
        }),
      ).toThrow(/whole number of minutes between -1439 and 1439/);
    },
  );
});
