import { describe, expect, it } from "vitest";

import { julianDayToOffsetIso, utcIsoToJulianDay } from "../calendar/jdn";
import { findSolarTerm } from "../calendar/solar-terms";
import { calculateSolarTime } from "../time/solar-time";
import { calculatePillars } from "./pillars";
import { SIXTY_JIA_ZI } from "./tables";

const secondsPerDay = 86_400;

function offsetFromUtc(utcIso: string, seconds: number): string {
  return julianDayToOffsetIso(
    utcIsoToJulianDay(utcIso) + seconds / secondsPerDay,
    0,
  );
}

function offsetIsoToJulianDay(offsetIso: string): number {
  const match = /^(.*)([+-])(\d{2}):(\d{2})$/.exec(offsetIso);
  if (!match) {
    throw new Error("Expected an ISO date-time with a numeric UTC offset.");
  }

  const [, localDateTime, sign, offsetHours, offsetMinutes] = match;
  const offset =
    (Number(offsetHours) * 60 + Number(offsetMinutes)) *
    (sign === "-" ? -1 : 1);
  return utcIsoToJulianDay(`${localDateTime}Z`) - offset / 1440;
}

describe("calculatePillars", () => {
  it.each(["+00:60", "+01:99"])(
    "rejects an out-of-range true-solar UTC offset (%s)",
    (offset) => {
      expect(() =>
        calculatePillars({
          utcIso: "2024-06-15T16:00:00Z",
          trueSolarIso: `2024-06-16T00:00:00${offset}`,
          localYear: 2024,
        }),
      ).toThrow(/invalid UTC offset/);
    },
  );

  it("accepts a true-solar offset with historical seconds", () => {
    const result = calculatePillars({
      utcIso: "1900-06-15T03:54:17.000Z",
      trueSolarIso: "1900-06-15T12:00:06.581+08:05:43",
      localYear: 1900,
    });

    expect(result.day).toEqual({ stem: "己", branch: "未", index: 55 });
    expect(result.hour).toEqual({ stem: "庚", branch: "午", index: 6 });
  });

  it("rejects an out-of-range seconds field in a true-solar offset", () => {
    expect(() =>
      calculatePillars({
        utcIso: "1900-06-15T03:54:17.000Z",
        trueSolarIso: "1900-06-15T12:00:06.581+08:05:60",
        localYear: 1900,
      }),
    ).toThrow(/invalid UTC offset/);
  });

  it("rejects a local year that does not match the true-solar wall year", () => {
    expect(() =>
      calculatePillars({
        utcIso: "2024-06-15T16:00:00Z",
        trueSolarIso: "2024-06-16T00:00:00+08:00",
        localYear: 2023,
      }),
    ).toThrow(/Local year must match the true-solar wall year/);
  });

  it("uses the birth instant rather than true solar time for jie boundaries", () => {
    const lichun = findSolarTerm(2024, "lichun").utcIso;
    const utcIso = offsetFromUtc(lichun, -5).replace("+00:00", "Z");
    const solarTime = calculateSolarTime({
      utcIso,
      longitude: 125,
      standardMeridianLongitude: 120,
      birthplaceOffsetMinutes: 480,
    });
    const result = calculatePillars({
      utcIso,
      trueSolarIso: solarTime.trueSolarIso,
      localYear: 2024,
      boundaryContext: { jieUtcIso: { lichun } },
    });

    expect(offsetIsoToJulianDay(solarTime.trueSolarIso)).toBeGreaterThan(
      utcIsoToJulianDay(lichun),
    );
    expect(result.year.index).toBe(39);
    expect(result.monthBoundary.term).toBe("xiaohan");
  });

  it("changes the year pillar exactly at the calculated lichun instant", () => {
    const lichun = findSolarTerm(2024, "lichun").utcIso;
    const beforeUtcIso = offsetFromUtc(lichun, -1).replace("+00:00", "Z");
    const afterUtcIso = offsetFromUtc(lichun, 1).replace("+00:00", "Z");
    const before = calculatePillars({
      utcIso: beforeUtcIso,
      trueSolarIso: beforeUtcIso,
      localYear: 2024,
      boundaryContext: { jieUtcIso: { lichun } },
    });
    const after = calculatePillars({
      utcIso: afterUtcIso,
      trueSolarIso: afterUtcIso,
      localYear: 2024,
      boundaryContext: { jieUtcIso: { lichun } },
    });

    expect(before.year).toEqual({ stem: "癸", branch: "卯", index: 39 });
    expect(before.month).toEqual({ stem: "乙", branch: "丑", index: 1 });
    expect(after.year).toEqual({ stem: "甲", branch: "辰", index: 40 });
    expect(after.month).toEqual({ stem: "丙", branch: "寅", index: 2 });
  });

  it("changes the day pillar at true-solar midnight", () => {
    const before = calculatePillars({
      utcIso: "2024-06-15T15:59:59Z",
      trueSolarIso: "2024-06-15T23:59:59+08:00",
      localYear: 2024,
    });
    const after = calculatePillars({
      utcIso: "2024-06-15T16:00:00Z",
      trueSolarIso: "2024-06-16T00:00:00+08:00",
      localYear: 2024,
    });

    expect(before.day).not.toEqual(after.day);
  });

  it("changes from 子 to 丑 exactly at the true-solar hour boundary", () => {
    const first = calculatePillars({
      utcIso: "2024-06-14T16:59:59Z",
      trueSolarIso: "2024-06-15T00:59:59+08:00",
      localYear: 2024,
    });
    const second = calculatePillars({
      utcIso: "2024-06-14T17:00:00Z",
      trueSolarIso: "2024-06-15T01:00:00+08:00",
      localYear: 2024,
    });

    expect(first.hour).toEqual({ stem: "丙", branch: "子", index: 12 });
    expect(second.hour).toEqual({ stem: "丁", branch: "丑", index: 13 });
  });

  it("uses the sixty JiaZi cycle and independently checked daily anchors", () => {
    expect(SIXTY_JIA_ZI).toHaveLength(60);
    expect(SIXTY_JIA_ZI[0]).toMatchObject({ stem: "甲", branch: "子", index: 0 });
    expect(SIXTY_JIA_ZI[0]).toEqual(SIXTY_JIA_ZI[60 % 60]);

    // Public calendar cross-checks: https://www.rili.com.cn/wannianli/2000/0107.html
    // https://www.nongli.info/birthday/nlsm.php?date=10&month=2&year=2024
    // https://reki.gozaaru.com/seireki/1949/10/1 and https://www.chinesecalendaronline.com/zh/1949/10/1.htm
    const goldenDates = [
      ["2000-01-07T12:00:00+00:00", 2000, 0],
      ["2024-02-10T12:00:00+00:00", 2024, 40],
      ["1949-10-01T12:00:00+00:00", 1949, 0],
    ] as const;

    for (const [trueSolarIso, localYear, index] of goldenDates) {
      expect(
        calculatePillars({
          utcIso: trueSolarIso.replace("+00:00", "Z"),
          trueSolarIso,
          localYear,
        }).day.index,
      ).toBe(index);
    }
  });

  it("changes the month pillar at jie instead of the lunar month", () => {
    const jingzhe = findSolarTerm(2024, "jingzhe").utcIso;
    const beforeUtcIso = offsetFromUtc(jingzhe, -1).replace("+00:00", "Z");
    const afterUtcIso = offsetFromUtc(jingzhe, 1).replace("+00:00", "Z");
    const before = calculatePillars({
      utcIso: beforeUtcIso,
      trueSolarIso: beforeUtcIso,
      localYear: 2024,
      boundaryContext: { jieUtcIso: { jingzhe } },
    });
    const after = calculatePillars({
      utcIso: afterUtcIso,
      trueSolarIso: afterUtcIso,
      localYear: 2024,
      boundaryContext: { jieUtcIso: { jingzhe } },
    });

    expect(before.month).toEqual({ stem: "丙", branch: "寅", index: 2 });
    expect(after.month).toEqual({ stem: "丁", branch: "卯", index: 3 });
  });
});
