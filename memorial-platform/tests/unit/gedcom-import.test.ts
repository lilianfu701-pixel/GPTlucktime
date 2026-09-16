import { describe, expect, it } from "vitest";
import {
  gedcomToDataset,
  parseGedcomDate,
} from "@/modules/genealogy/import/sources/gedcom";

/**
 * A minimal GEDCOM: two parents, two children, one marriage — enough to prove
 * INDI records become people and FAM records become the parent and spouse edges.
 */
const SAMPLE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME 孔祥珂
1 SEX M
1 BIRT
2 DATE 1848
2 PLAC 曲阜
1 DEAT
2 DATE 1876
0 @I2@ INDI
1 NAME 彭氏
1 SEX F
0 @I3@ INDI
1 NAME 孔令贻
1 SEX M
1 BIRT
2 DATE 30 NOV 1872
1 DEAT
2 DATE ABT 1919
0 @I4@ INDI
1 NAME 孔庆镕
1 SEX M
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 @F2@ FAM
1 HUSB @I4@
1 CHIL @I1@
0 TRLR`;

describe("parseGedcomDate", () => {
  it("reads a full day-month-year date", () => {
    expect(parseGedcomDate("30 NOV 1872")).toEqual({
      year: 1872,
      month: 11,
      day: 30,
    });
  });

  it("reads a year-only date", () => {
    expect(parseGedcomDate("1848")).toEqual({ year: 1848 });
  });

  it("strips approximate qualifiers", () => {
    expect(parseGedcomDate("ABT 1919")).toEqual({ year: 1919 });
    expect(parseGedcomDate("BET 1940 AND 1946")).toEqual({ year: 1940 });
  });

  it("yields nothing without a plausible year", () => {
    expect(parseGedcomDate("")).toBeUndefined();
    expect(parseGedcomDate("unknown")).toBeUndefined();
  });
});

describe("gedcomToDataset", () => {
  const dataset = gedcomToDataset(SAMPLE, {
    key: "test",
    citation: "sample.ged",
  });

  it("turns every named INDI into a person with its citation", () => {
    expect(dataset.people).toHaveLength(4);
    const kongLingyi = dataset.people.find((p) => p.externalId === "I3");
    expect(kongLingyi).toMatchObject({
      name: "孔令贻",
      gender: "male",
      birth: { year: 1872, month: 11, day: 30 },
      death: { year: 1919 },
      citation: "sample.ged",
    });
  });

  it("reads a birthplace", () => {
    const xiangke = dataset.people.find((p) => p.externalId === "I1");
    expect(xiangke?.birthPlace).toEqual({ city: "曲阜" });
  });

  it("derives a spouse edge from HUSB + WIFE", () => {
    expect(dataset.relations).toContainEqual({
      kind: "spouse",
      a: "I1",
      b: "I2",
    });
  });

  it("derives parent edges from both parents to each child", () => {
    expect(dataset.relations).toContainEqual({
      kind: "parent",
      parent: "I1",
      child: "I3",
    });
    expect(dataset.relations).toContainEqual({
      kind: "parent",
      parent: "I2",
      child: "I3",
    });
    // A single-parent family (only HUSB recorded) still yields its one edge.
    expect(dataset.relations).toContainEqual({
      kind: "parent",
      parent: "I4",
      child: "I1",
    });
  });
});
