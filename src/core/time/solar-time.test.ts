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
});
