import { describe, expect, it } from "vitest";

import {
  TWELVE_LIFE_STAGES,
  nayinFor,
  twelveLifeStageFor,
  xunKongFor,
} from "./auxiliary";
import { ELEMENTS, STEM_ELEMENTS, countElements } from "./elements";
import { NINE_STARS, deriveKyusei, natalStarForSolarYear } from "./kyusei";
import {
  PILLAR_POSITIONS,
  deriveRelations,
  type FourPillars,
} from "./relations";
import { TEN_GODS, deriveTenGods, tenGodFor } from "./ten-gods";

const pillars: FourPillars = {
  year: { stem: "甲", branch: "子", index: 0 },
  month: { stem: "己", branch: "巳", index: 5 },
  day: { stem: "甲", branch: "午", index: 30 },
  hour: { stem: "庚", branch: "申", index: 56 },
};

describe("static Bazi indicators", () => {
  it("derives ten gods from five-element direction and polarity", () => {
    expect(tenGodFor("甲", "乙")).toBe("劫财");
    expect(tenGodFor("甲", "丙")).toBe("食神");

    const facts = deriveTenGods("甲", pillars);
    expect(facts.visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pillarPosition: "month", stem: "己", tenGod: "正财" }),
      ]),
    );
    expect(facts.hidden).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pillarPosition: "year", stem: "癸", tenGod: "正印" }),
      ]),
    );
  });

  it("counts visible and hidden elements separately", () => {
    expect(countElements(pillars)).toEqual({
      visible: { wood: 2, fire: 0, earth: 1, metal: 1, water: 0 },
      hidden: { wood: 0, fire: 2, earth: 3, metal: 2, water: 2 },
    });
  });

  it("records stem and branch relations with their pillar positions", () => {
    const relations = deriveRelations(pillars);

    expect(relations).toEqual(
      expect.arrayContaining([
        {
          ruleId: "stem.combine.jia-ji.v1",
          type: "stem-combine",
          participants: ["甲", "己"],
          pillarPositions: ["year", "month"],
        },
        {
          ruleId: "branch.clash.zi-wu.v1",
          type: "branch-clash",
          participants: ["子", "午"],
          pillarPositions: ["year", "day"],
        },
        {
          ruleId: "branch.combine.si-shen.v1",
          type: "branch-combine",
          participants: ["巳", "申"],
          pillarPositions: ["month", "hour"],
        },
      ]),
    );
  });

  it("does not infer binary relations from repeated stems or branches", () => {
    const repeated: FourPillars = {
      year: { stem: "甲", branch: "子", index: 0 },
      month: { stem: "甲", branch: "子", index: 0 },
      day: { stem: "甲", branch: "子", index: 0 },
      hour: { stem: "甲", branch: "子", index: 0 },
    };

    expect(deriveRelations(repeated)).toEqual([]);
  });

  it("returns the exact relation records without duplicates", () => {
    const exact: FourPillars = {
      year: { stem: "甲", branch: "子", index: 0 },
      month: { stem: "己", branch: "丑", index: 1 },
      day: { stem: "庚", branch: "午", index: 6 },
      hour: { stem: "丁", branch: "卯", index: 3 },
    };

    expect(deriveRelations(exact)).toEqual([
      {
        ruleId: "stem.combine.jia-ji.v1",
        type: "stem-combine",
        participants: ["甲", "己"],
        pillarPositions: ["year", "month"],
      },
      {
        ruleId: "stem.clash.jia-geng.v1",
        type: "stem-clash",
        participants: ["甲", "庚"],
        pillarPositions: ["year", "day"],
      },
      {
        ruleId: "branch.combine.zi-chou.v1",
        type: "branch-combine",
        participants: ["子", "丑"],
        pillarPositions: ["year", "month"],
      },
      {
        ruleId: "branch.clash.zi-wu.v1",
        type: "branch-clash",
        participants: ["子", "午"],
        pillarPositions: ["year", "day"],
      },
      {
        ruleId: "branch.harm.chou-wu.v1",
        type: "branch-harm",
        participants: ["丑", "午"],
        pillarPositions: ["month", "day"],
      },
      {
        ruleId: "branch.break.mao-wu.v1",
        type: "branch-break",
        participants: ["卯", "午"],
        pillarPositions: ["hour", "day"],
      },
      {
        ruleId: "branch.punishment.zi-mao.v1",
        type: "branch-punishment",
        participants: ["子", "卯"],
        pillarPositions: ["year", "hour"],
      },
    ]);
  });

  it("records branch triads, meetings, and self-punishment", () => {
    const triadAndSelfPunishment: FourPillars = {
      year: { stem: "甲", branch: "申", index: 0 },
      month: { stem: "乙", branch: "子", index: 1 },
      day: { stem: "丙", branch: "辰", index: 2 },
      hour: { stem: "丁", branch: "辰", index: 3 },
    };
    const meeting: FourPillars = {
      year: { stem: "甲", branch: "亥", index: 0 },
      month: { stem: "乙", branch: "子", index: 1 },
      day: { stem: "丙", branch: "丑", index: 2 },
      hour: { stem: "丁", branch: "寅", index: 3 },
    };

    expect(deriveRelations(triadAndSelfPunishment)).toEqual(
      expect.arrayContaining([
        {
          ruleId: "branch.triad.shen-zi-chen.v1",
          type: "branch-triad",
          participants: ["申", "子", "辰"],
          pillarPositions: ["year", "month", "day"],
        },
        {
          ruleId: "branch.punishment.self-辰.v1",
          type: "branch-punishment",
          participants: ["辰", "辰"],
          pillarPositions: ["day", "hour"],
        },
      ]),
    );
    expect(deriveRelations(meeting)).toEqual(
      expect.arrayContaining([
        {
          ruleId: "branch.meeting.hai-zi-chou.v1",
          type: "branch-meeting",
          participants: ["亥", "子", "丑"],
          pillarPositions: ["year", "month", "day"],
        },
      ]),
    );
  });

  it("returns table-driven auxiliary facts without interpretation", () => {
    expect(nayinFor(pillars.year)).toEqual({
      ruleId: "aux.nayin.v1",
      name: "海中金",
    });
    expect(xunKongFor(pillars.year)).toEqual({
      ruleId: "aux.xunkong.v1",
      voidBranches: ["戌", "亥"],
    });
    expect(twelveLifeStageFor("甲", "亥")).toEqual({
      ruleId: "aux.twelve-life-stage.v1",
      stage: "长生",
    });
  });

  it("derives natal and month stars from the supplied solar year and month branch", () => {
    // Public golden references:
    // https://masanosuke.net/kusei/kusei-calculator-guide/ (2000 -> 九紫火星)
    // https://yakumoin.info/check/ninestar/day/20000926 (2000-09-26 -> 九紫火星 / 七赤金星)
    // https://www.divination.page/2024/04/200012.html (2000 立春前 -> 1999 的一白水星)
    expect(natalStarForSolarYear(2000)).toMatchObject({
      number: 9,
      name: "九紫火星",
    });
    expect(natalStarForSolarYear(1999)).toMatchObject({
      number: 1,
      name: "一白水星",
    });
    // The solar-month table is independently recorded at:
    // https://fem-haregocoro.ssl-lolipop.jp/pdf/star_list.pdf
    expect(deriveKyusei({ solarYear: 2000, solarMonthBranch: "寅" }).month.star).toEqual({
      number: 5,
      name: "五黄土星",
      element: "earth",
    });
    expect(deriveKyusei({ solarYear: 2000, solarMonthBranch: "午" }).month.star).toEqual({
      number: 1,
      name: "一白水星",
      element: "water",
    });
    expect(deriveKyusei({ solarYear: 2000, solarMonthBranch: "酉" })).toEqual({
      natal: {
        ruleId: "kyusei.natal.v1",
        star: { number: 9, name: "九紫火星", element: "fire" },
      },
      month: {
        ruleId: "kyusei.month.v1",
        star: { number: 7, name: "七赤金星", element: "metal" },
      },
    });
  });

  it.each([
    {
      solarYear: 1999,
      natalGroup: "一・四・七",
      natalNumber: 1,
      monthStar: { number: 8, name: "八白土星", element: "earth" },
    },
    {
      solarYear: 2001,
      natalGroup: "二・五・八",
      natalNumber: 8,
      monthStar: { number: 2, name: "二黑土星", element: "earth" },
    },
    {
      solarYear: 2000,
      natalGroup: "三・六・九",
      natalNumber: 9,
      monthStar: { number: 5, name: "五黄土星", element: "earth" },
    },
  ] as const)(
    "maps solar year $solarYear in natal group $natalGroup to the golden 寅-month star",
    ({ solarYear, natalNumber, monthStar }) => {
      // Rule-table basis: the 本命星 rows and the 月命星 2/4-3/5 (寅月)
      // columns are published together at:
      // https://fem-haregocoro.ssl-lolipop.jp/pdf/star_list.pdf
      const result = deriveKyusei({ solarYear, solarMonthBranch: "寅" });

      expect(result.natal.star.number).toBe(natalNumber);
      expect(result.month.star).toEqual(monthStar);
    },
  );

  it("freezes every exported static indicator table", () => {
    expect(Object.isFrozen(ELEMENTS)).toBe(true);
    expect(Object.isFrozen(STEM_ELEMENTS)).toBe(true);
    expect(Object.isFrozen(TEN_GODS)).toBe(true);
    expect(Object.isFrozen(PILLAR_POSITIONS)).toBe(true);
    expect(Object.isFrozen(TWELVE_LIFE_STAGES)).toBe(true);
    expect(Object.isFrozen(NINE_STARS)).toBe(true);
  });
});
