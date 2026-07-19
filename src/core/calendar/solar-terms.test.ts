import { describe, expect, it } from "vitest";

import { julianDayToOffsetIso, utcIsoToJulianDay } from "./jdn";
import { findSolarTerm } from "./solar-terms";

describe("Julian day and solar terms", () => {
  it("calculates a deterministic JDN for the same UTC instant", () => {
    const utcIso = "2024-02-04T08:26:53.000Z";

    expect(utcIsoToJulianDay(utcIso)).toBe(utcIsoToJulianDay(utcIso));
    expect(utcIsoToJulianDay("2000-01-01T12:00:00.000Z")).toBe(2_451_545);
    expect(utcIsoToJulianDay("2000-01-01T00:00:00.000Z")).toBe(2_451_544.5);
  });

  it("formats offset-adjusted Julian days across calendar boundaries", () => {
    const utcJulianDay = utcIsoToJulianDay("2000-01-01T23:30:00.000Z");

    expect(julianDayToOffsetIso(utcJulianDay, 120)).toBe(
      "2000-01-02T01:30:00.000+02:00",
    );
    expect(julianDayToOffsetIso(utcJulianDay, 90.5)).toBe(
      "2000-01-02T01:00:30.000+01:30:30",
    );
    expect(julianDayToOffsetIso(utcJulianDay, 90.51)).toBe(
      "2000-01-02T01:00:31.000+01:30:31",
    );
    expect(() => julianDayToOffsetIso(10_000_000, 0)).toThrow(
      /four-digit Gregorian year/,
    );
  });

  it("finds 2024 lichun within two minutes of the published instant", () => {
    const actual = utcIsoToJulianDay(findSolarTerm(2024, "lichun").utcIso);
    const expected = utcIsoToJulianDay("2024-02-04T08:26:53.000Z");

    expect(Math.abs(actual - expected) * 86_400_000).toBeLessThanOrEqual(
      120_000,
    );
  });

  it("maps jingzhe to its 345-degree boundary and representative instant", () => {
    const result = findSolarTerm(2024, "jingzhe");
    const actual = utcIsoToJulianDay(result.utcIso);
    const expected = utcIsoToJulianDay("2024-03-05T02:22:28.877Z");

    expect(result.targetLongitude).toBe(345);
    expect(Math.abs(actual - expected) * 86_400_000).toBeLessThanOrEqual(
      120_000,
    );
  });
});
