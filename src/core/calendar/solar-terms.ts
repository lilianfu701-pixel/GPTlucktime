import { AstroTime, SearchSunLongitude } from "astronomy-engine";

import { utcIsoToJulianDay } from "./jdn";

export const solarTerms = Object.freeze([
  "lichun",
  "jingzhe",
  "qingming",
  "lixia",
  "mangzhong",
  "xiaoshu",
  "liqiu",
  "bailu",
  "hanlu",
  "lidong",
  "daxue",
  "xiaohan",
] as const);

export type SolarTerm = (typeof solarTerms)[number];

export interface SolarTermResult {
  readonly term: SolarTerm;
  readonly targetLongitude: number;
  readonly utcIso: string;
  readonly algorithmVersion: string;
}

const astronomyJ2000JulianDay = 2_451_545;
const algorithmVersion = "astronomy-engine@2.1.19/search-sun-longitude-v1";

function isSolarTerm(value: string): value is SolarTerm {
  return (solarTerms as readonly string[]).includes(value);
}

function targetLongitude(term: SolarTerm): number {
  return (315 + solarTerms.indexOf(term) * 30) % 360;
}

/** Finds one of the twelve jie boundaries using Astronomy Engine's apparent solar longitude. */
export function findSolarTerm(year: number, term: SolarTerm): SolarTermResult {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError("Solar-term year must be a four-digit Gregorian year.");
  }
  if (!isSolarTerm(term)) {
    throw new RangeError("Unknown solar term.");
  }

  const startIso = `${year.toString().padStart(4, "0")}-01-01T00:00:00.000Z`;
  const event = SearchSunLongitude(
    targetLongitude(term),
    new AstroTime(utcIsoToJulianDay(startIso) - astronomyJ2000JulianDay),
    370,
  );
  if (!event) {
    throw new RangeError("Solar longitude was not found inside the search window.");
  }

  return Object.freeze({
    term,
    targetLongitude: targetLongitude(term),
    utcIso: event.toString(),
    algorithmVersion,
  });
}
