import { AstroTime, Body, HourAngle, Observer } from "astronomy-engine";

import {
  julianDayToOffsetIso,
  parseUtcIso,
  utcIsoToJulianDay,
} from "../calendar/jdn";

export interface SolarTimeInput {
  utcIso: string;
  longitude: number;
  standardMeridianLongitude: number;
  birthplaceOffsetMinutes?: number;
}

export interface SolarTimeResult {
  readonly longitudeCorrectionSeconds: number;
  readonly equationOfTimeSeconds: number;
  readonly trueSolarIso: string;
  readonly jdn: number;
}

const astronomyJ2000JulianDay = 2_451_545;
const secondsPerDay = 86_400;
const greenwichObserver = new Observer(0, 0, 0);

function normalizeSignedHours(hours: number): number {
  return ((hours + 12) % 24 + 24) % 24 - 12;
}

function equationOfTimeSeconds(utcIso: string, julianDay: number): number {
  const utc = parseUtcIso(utcIso);
  const utcHours =
    utc.hour +
    utc.minute / 60 +
    utc.second / 3600 +
    utc.millisecond / 3_600_000;
  const time = new AstroTime(julianDay - astronomyJ2000JulianDay);
  const apparentSolarHours =
    HourAngle(Body.Sun, time, greenwichObserver) + 12;

  return normalizeSignedHours(apparentSolarHours - utcHours) * 3600;
}

/** Calculates true solar time from a UTC instant using Astronomy Engine's solar geometry. */
export function calculateSolarTime(input: SolarTimeInput): SolarTimeResult {
  if (
    !Number.isFinite(input.longitude) ||
    !Number.isFinite(input.standardMeridianLongitude) ||
    (input.birthplaceOffsetMinutes !== undefined &&
      !Number.isFinite(input.birthplaceOffsetMinutes))
  ) {
    throw new RangeError("Solar-time coordinates and offset must be finite numbers.");
  }

  const jdn = utcIsoToJulianDay(input.utcIso);
  const longitudeCorrectionSeconds =
    (input.longitude - input.standardMeridianLongitude) * 240;
  const eotSeconds = equationOfTimeSeconds(input.utcIso, jdn);
  const trueSolarJulianDay =
    jdn + (longitudeCorrectionSeconds + eotSeconds) / secondsPerDay;

  return Object.freeze({
    longitudeCorrectionSeconds,
    equationOfTimeSeconds: eotSeconds,
    trueSolarIso: julianDayToOffsetIso(
      trueSolarJulianDay,
      input.birthplaceOffsetMinutes ?? 0,
    ),
    jdn,
  });
}
