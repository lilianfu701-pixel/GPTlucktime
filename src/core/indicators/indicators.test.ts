import { describe, expect, it } from "vitest";

import {
  nayinFor,
  twelveLifeStageFor,
  xunKongFor,
} from "./auxiliary";
import { countElements } from "./elements";
import { deriveKyusei, natalStarForSolarYear } from "./kyusei";
import { deriveRelations, type FourPillars } from "./relations";
import { deriveTenGods, tenGodFor } from "./ten-gods";

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
});
