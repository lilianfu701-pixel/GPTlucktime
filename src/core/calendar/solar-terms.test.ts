import { describe, expect, it } from "vitest";

import { utcIsoToJulianDay } from "./jdn";
import { findSolarTerm } from "./solar-terms";

describe("Julian day and solar terms", () => {
  it("calculates a deterministic JDN for the same UTC instant", () => {
    const utcIso = "2024-02-04T08:26:53.000Z";

    expect(utcIsoToJulianDay(utcIso)).toBe(utcIsoToJulianDay(utcIso));
    expect(utcIsoToJulianDay("2000-01-01T12:00:00.000Z")).toBe(2_451_545);
  });

  it("finds 2024 lichun within two minutes of the published instant", () => {
    const actual = utcIsoToJulianDay(findSolarTerm(2024, "lichun").utcIso);
    const expected = utcIsoToJulianDay("2024-02-04T08:26:53.000Z");

    expect(Math.abs(actual - expected) * 86_400_000).toBeLessThanOrEqual(
      120_000,
    );
  });
});
