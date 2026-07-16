import { describe, expect, it } from "vitest";

import { julianDayToOffsetIso, utcIsoToJulianDay } from "../calendar/jdn";
import { findSolarTerm } from "../calendar/solar-terms";
import { calculatePillars } from "./pillars";
import { SIXTY_JIA_ZI } from "./tables";

const secondsPerDay = 86_400;

function offsetFromUtc(utcIso: string, seconds: number): string {
  return julianDayToOffsetIso(
    utcIsoToJulianDay(utcIso) + seconds / secondsPerDay,
    0,
  );
}

describe("calculatePillars", () => {
  it("changes the year pillar exactly at the calculated lichun instant", () => {
    const lichun = findSolarTerm(2024, "lichun").utcIso;
    const before = calculatePillars({
      trueSolarIso: offsetFromUtc(lichun, -1),
      localYear: 2024,
      boundaryContext: { jieUtcIso: { lichun } },
    });
    const after = calculatePillars({
      trueSolarIso: offsetFromUtc(lichun, 1),
      localYear: 2024,
      boundaryContext: { jieUtcIso: { lichun } },
    });

    expect(before.year).not.toEqual(after.year);
  });

  it("changes the day pillar at true-solar midnight", () => {
    const before = calculatePillars({
      trueSolarIso: "2024-06-15T23:59:59+08:00",
      localYear: 2024,
    });
    const after = calculatePillars({
      trueSolarIso: "2024-06-16T00:00:00+08:00",
      localYear: 2024,
    });

    expect(before.day).not.toEqual(after.day);
  });

  it("changes the hour pillar across a two-hour branch boundary", () => {
    const first = calculatePillars({
      trueSolarIso: "2024-06-15T00:30:00+08:00",
      localYear: 2024,
    });
    const second = calculatePillars({
      trueSolarIso: "2024-06-15T02:30:00+08:00",
      localYear: 2024,
    });

    expect(first.hour).not.toEqual(second.hour);
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
      expect(calculatePillars({ trueSolarIso, localYear }).day.index).toBe(index);
    }
  });

  it("changes the month pillar at jie instead of the lunar month", () => {
    const jingzhe = findSolarTerm(2024, "jingzhe").utcIso;
    const before = calculatePillars({
      trueSolarIso: offsetFromUtc(jingzhe, -1),
      localYear: 2024,
      boundaryContext: { jieUtcIso: { jingzhe } },
    });
    const after = calculatePillars({
      trueSolarIso: offsetFromUtc(jingzhe, 1),
      localYear: 2024,
      boundaryContext: { jieUtcIso: { jingzhe } },
    });

    expect(before.month).not.toEqual(after.month);
  });
});
