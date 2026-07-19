import { describe, expect, it } from "vitest";

import { julianDayToOffsetIso, utcIsoToJulianDay } from "./calendar/jdn";
import { findSolarTerm } from "./calendar/solar-terms";
import {
  WARNING_THRESHOLDS_SECONDS,
  buildChartContext,
  type ChartContextResult,
} from "./build-chart-context";

const secondsPerDay = 86_400;
const baseInput = {
  localDateTime: "1990-06-15T14:30:00",
  timeZone: "Asia/Shanghai",
  birthplace: {
    name: "Shanghai",
    latitude: 31.2304,
    longitude: 121.4737,
  },
  timePrecision: "exact" as const,
};

function success(result: ChartContextResult) {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(`Expected chart success, received ${result.code}`);
  }
  return result.value;
}

function utcOffsetLocalDateTime(utcIso: string, offsetSeconds: number): string {
  return julianDayToOffsetIso(
    utcIsoToJulianDay(utcIso) + offsetSeconds / secondsPerDay,
    0,
  ).replace("+00:00", "");
}

function utcInput(localDateTime: string) {
  return {
    ...baseInput,
    localDateTime,
    timeZone: "Etc/UTC",
    birthplace: { name: "Greenwich", latitude: 0, longitude: 0 },
  };
}

function warningCodes(result: ChartContextResult): string[] {
  return success(result).warnings.map((warning) => warning.code);
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeepFrozen(nested, seen);
  }
}

describe("buildChartContext", () => {
  it("assembles a complete traceable static chart in derivation order", () => {
    const chart = success(buildChartContext(baseInput));

    expect(chart.input).toMatchObject(baseInput);
    expect(chart.civilTime).toMatchObject({
      utcIso: "1990-06-15T05:30:00.000Z",
      offsetMinutes: 540,
      dstOffsetMinutes: 60,
    });
    expect(chart.solarTime).toMatchObject({
      jdn: expect.any(Number),
      trueSolarIso: expect.stringMatching(/\+09:00$/),
    });
    expect(utcIsoToJulianDay(chart.solarTerms.previous.utcIso)).toBeLessThan(
      utcIsoToJulianDay(chart.solarTerms.current.utcIso),
    );
    expect(utcIsoToJulianDay(chart.solarTerms.current.utcIso)).toBeLessThanOrEqual(
      utcIsoToJulianDay(chart.civilTime.utcIso),
    );
    expect(utcIsoToJulianDay(chart.solarTerms.next.utcIso)).toBeGreaterThan(
      utcIsoToJulianDay(chart.civilTime.utcIso),
    );
    expect(chart.pillars).toMatchObject({
      year: { stem: expect.any(String), branch: expect.any(String), index: expect.any(Number) },
      month: { stem: expect.any(String), branch: expect.any(String), index: expect.any(Number) },
      day: { stem: expect.any(String), branch: expect.any(String), index: expect.any(Number) },
      hour: { stem: expect.any(String), branch: expect.any(String), index: expect.any(Number) },
    });
    expect(chart.indicators).toEqual(
      expect.objectContaining({
        tenGods: expect.any(Object),
        elements: expect.any(Object),
        relations: expect.any(Array),
        auxiliary: expect.any(Object),
        kyusei: expect.any(Object),
      }),
    );
    expect(chart.trace.map((item) => item.id)).toEqual([
      "input.normalize",
      "time.civil.resolve",
      "time.solar.calculate",
      "calendar.solar-terms.locate",
      "pillars.calculate",
      "indicators.ten-gods",
      "indicators.elements",
      "indicators.relations",
      "indicators.auxiliary",
      "indicators.kyusei",
    ]);
    for (const trace of chart.trace) {
      expect(trace).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          ruleId: expect.any(String),
          inputs: expect.anything(),
          output: expect.anything(),
          versionKey: expect.any(String),
        }),
      );
      expect(chart.versions).toHaveProperty(trace.versionKey);
    }
  });

  it("returns structured input and DST failures without throwing", () => {
    const invalid = { ...baseInput, birthplace: { ...baseInput.birthplace, latitude: 91 } };
    const gap = {
      ...baseInput,
      localDateTime: "2024-03-10T02:30:00",
      timeZone: "America/New_York",
      birthplace: { name: "New York", latitude: 40.7128, longitude: -74.006 },
    };
    const ambiguous = { ...gap, localDateTime: "2024-11-03T01:30:00" };

    expect(() => buildChartContext(invalid)).not.toThrow();
    expect(buildChartContext(invalid)).toMatchObject({
      ok: false,
      stage: "input",
      code: "INVALID_COORDINATES",
    });
    expect(buildChartContext(gap)).toMatchObject({
      ok: false,
      stage: "civil-time",
      code: "DST_GAP",
    });
    expect(buildChartContext(ambiguous)).toMatchObject({
      ok: false,
      stage: "civil-time",
      code: "DST_AMBIGUOUS",
    });
  });

  it("warns when a repeated DST time is explicitly resolved", () => {
    const chart = success(
      buildChartContext({
        ...baseInput,
        localDateTime: "2024-11-03T01:30:00",
        timeZone: "America/New_York",
        birthplace: { name: "New York", latitude: 40.7128, longitude: -74.006 },
        civilTimeResolution: "later",
      }),
    );

    expect(chart.civilTime.resolution).toBe("later");
    expect(chart.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DST_OVERLAP_RESOLVED" }),
      ]),
    );
  });

  it.each(["approximate", "unknown"] as const)(
    "warns for %s birth-time precision",
    (timePrecision) => {
      expect(warningCodes(buildChartContext({ ...baseInput, timePrecision }))).toContain(
        timePrecision === "approximate"
          ? "TIME_PRECISION_APPROXIMATE"
          : "TIME_PRECISION_UNKNOWN",
      );
    },
  );

  it("uses the named near-solar-term threshold on both sides of the boundary", () => {
    const lichun = findSolarTerm(2024, "lichun").utcIso;
    const threshold = WARNING_THRESHOLDS_SECONDS.solarTerm;
    const inside = success(
      buildChartContext(utcInput(utcOffsetLocalDateTime(lichun, -threshold + 1))),
    );
    const outside = success(
      buildChartContext(utcInput(utcOffsetLocalDateTime(lichun, -threshold - 1))),
    );

    expect(inside.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "NEAR_SOLAR_TERM_BOUNDARY",
          thresholdSeconds: threshold,
        }),
      ]),
    );
    expect(outside.warnings.some((warning) => warning.code === "NEAR_SOLAR_TERM_BOUNDARY"))
      .toBe(false);
  });

  it("uses named true-solar midnight and double-hour thresholds inside and outside", () => {
    const midnightInside = success(buildChartContext(utcInput("2024-06-01T00:00:00")));
    const midnightOutside = success(buildChartContext(utcInput("2024-06-01T00:15:00")));
    const hourInside = success(buildChartContext(utcInput("2024-06-01T00:58:00")));
    const hourOutside = success(buildChartContext(utcInput("2024-06-01T00:45:00")));

    expect(WARNING_THRESHOLDS_SECONDS.trueSolarMidnight).toBe(600);
    expect(WARNING_THRESHOLDS_SECONDS.doubleHour).toBe(600);
    expect(midnightInside.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NEAR_TRUE_SOLAR_MIDNIGHT" }),
      ]),
    );
    expect(midnightOutside.warnings.some((warning) => warning.code === "NEAR_TRUE_SOLAR_MIDNIGHT"))
      .toBe(false);
    expect(hourInside.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NEAR_DOUBLE_HOUR_BOUNDARY" }),
      ]),
    );
    expect(hourOutside.warnings.some((warning) => warning.code === "NEAR_DOUBLE_HOUR_BOUNDARY"))
      .toBe(false);
  });

  it("is deterministic and recursively freezes every successful value", () => {
    const first = buildChartContext(baseInput);
    const second = buildChartContext(baseInput);

    expect(first).toEqual(second);
    expectDeepFrozen(first);
  });

  it("preserves residence context without changing the static chart", () => {
    const withoutResidence = success(buildChartContext(baseInput));
    const residenceContext = {
      name: "Los Angeles",
      latitude: 34.0522,
      longitude: -118.2437,
      timeZone: "America/Los_Angeles",
    };
    const withResidence = success(
      buildChartContext({ ...baseInput, residenceContext }),
    );

    expect(withResidence.input.residenceContext).toEqual(residenceContext);
    expect(withResidence.civilTime).toEqual(withoutResidence.civilTime);
    expect(withResidence.solarTime).toEqual(withoutResidence.solarTime);
    expect(withResidence.solarTerms).toEqual(withoutResidence.solarTerms);
    expect(withResidence.pillars).toEqual(withoutResidence.pillars);
    expect(withResidence.indicators).toEqual(withoutResidence.indicators);
  });
});
