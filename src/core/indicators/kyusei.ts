import type { EarthlyBranch } from "../pillars/tables";
import type { Element } from "./elements";

export interface NineStar {
  readonly number: number;
  readonly name: string;
  readonly element: Element;
}

export const NINE_STARS: readonly NineStar[] = Object.freeze([
  Object.freeze({ number: 1, name: "一白水星", element: "water" as const }),
  Object.freeze({ number: 2, name: "二黑土星", element: "earth" as const }),
  Object.freeze({ number: 3, name: "三碧木星", element: "wood" as const }),
  Object.freeze({ number: 4, name: "四绿木星", element: "wood" as const }),
  Object.freeze({ number: 5, name: "五黄土星", element: "earth" as const }),
  Object.freeze({ number: 6, name: "六白金星", element: "metal" as const }),
  Object.freeze({ number: 7, name: "七赤金星", element: "metal" as const }),
  Object.freeze({ number: 8, name: "八白土星", element: "earth" as const }),
  Object.freeze({ number: 9, name: "九紫火星", element: "fire" as const }),
]);

const MONTH_STAR_NUMBERS_BY_BRANCH: Readonly<Record<EarthlyBranch, readonly [number, number, number]>> = Object.freeze({
  子: [7, 1, 4], 丑: [6, 9, 3], 寅: [8, 2, 5], 卯: [7, 1, 4], 辰: [6, 9, 3], 巳: [5, 8, 2],
  午: [4, 7, 1], 未: [3, 6, 9], 申: [2, 5, 8], 酉: [1, 4, 7], 戌: [9, 3, 6], 亥: [8, 2, 5],
});

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function starByNumber(number: number): NineStar {
  return NINE_STARS[number - 1];
}

function natalGroup(number: number): 0 | 1 | 2 {
  return (number - 1) % 3 as 0 | 1 | 2;
}

/** Uses a supplied solar year; callers must already apply the exact lichun boundary. */
export function natalStarForSolarYear(solarYear: number): NineStar {
  if (!Number.isInteger(solarYear)) {
    throw new RangeError("Solar year must be an integer.");
  }
  const number = mod(2009 - solarYear, 9) || 9;
  return starByNumber(number);
}

export function deriveKyusei(input: Readonly<{ solarYear: number; solarMonthBranch: EarthlyBranch }>): Readonly<{
  natal: Readonly<{ ruleId: "kyusei.natal.v1"; star: NineStar }>;
  month: Readonly<{ ruleId: "kyusei.month.v1"; star: NineStar }>;
}> {
  const natalStar = natalStarForSolarYear(input.solarYear);
  const monthNumber = MONTH_STAR_NUMBERS_BY_BRANCH[input.solarMonthBranch][natalGroup(natalStar.number)];
  return Object.freeze({
    natal: Object.freeze({ ruleId: "kyusei.natal.v1", star: natalStar }),
    month: Object.freeze({ ruleId: "kyusei.month.v1", star: starByNumber(monthNumber) }),
  });
}
