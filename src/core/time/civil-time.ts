import {
  DateTime,
  TimeStruct,
  TimeZone,
  TzDatabase,
} from "timezonecomplete";

import type { CivilTimeResolution } from "../types";

type CivilTimeErrorCode =
  | "DST_GAP"
  | "DST_AMBIGUOUS"
  | "INVALID_CIVIL_TIME_RESOLUTION"
  | "INVALID_LOCAL_DATE_TIME"
  | "INVALID_TIME_ZONE";

export type CivilTimeResult =
  | Readonly<{
      ok: true;
      value: Readonly<{
        utcIso: string;
        offsetMinutes: number;
        dstOffsetMinutes: number;
        standardMeridianLongitude: number;
        resolution: CivilTimeResolution | null;
      }>;
    }>
  | Readonly<{
      ok: false;
      code: CivilTimeErrorCode;
      message: string;
    }>;

const localDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
const millisecondsPerMinute = 60_000;

function failure(code: CivilTimeErrorCode, message: string): CivilTimeResult {
  return Object.freeze({ ok: false as const, code, message });
}

function parseLocalDateTime(value: string): TimeStruct | null {
  if (!localDateTimePattern.test(value)) {
    return null;
  }

  try {
    return TimeStruct.fromString(value);
  } catch {
    return null;
  }
}

function validUtcCandidates(
  database: TzDatabase,
  timeZone: string,
  localTime: TimeStruct,
): ReadonlyArray<{ utcMillis: number; offsetMinutes: number }> {
  const offsets = new Set(
    database
      .getTransitionsTotalOffsets(
        timeZone,
        localTime.components.year - 1,
        localTime.components.year + 1,
      )
      .map((transition) => transition.offset.minutes()),
  );

  return [...offsets]
    .map((offsetMinutes) => ({
      utcMillis: localTime.unixMillis - offsetMinutes * millisecondsPerMinute,
      offsetMinutes,
    }))
    .filter(
      (candidate) =>
        database.totalOffset(timeZone, candidate.utcMillis).minutes() ===
        candidate.offsetMinutes,
    )
    .sort((left, right) => left.utcMillis - right.utcMillis);
}

/** Resolves wall-clock time through timezonecomplete's bundled IANA transition data. */
export function resolveCivilTime(
  localDateTime: string,
  timeZone: string,
  resolution?: CivilTimeResolution,
): CivilTimeResult {
  try {
    if (
      resolution !== undefined &&
      resolution !== "earlier" &&
      resolution !== "later"
    ) {
      return failure(
        "INVALID_CIVIL_TIME_RESOLUTION",
        "Civil time resolution must be either earlier or later.",
      );
    }

    const localTime = parseLocalDateTime(localDateTime);
    if (!localTime) {
      return failure(
        "INVALID_LOCAL_DATE_TIME",
        "Local date-time must be ISO formatted without a UTC offset.",
      );
    }

    const database = TzDatabase.instance();
    if (!database.exists(timeZone)) {
      return failure("INVALID_TIME_ZONE", "Time zone must be a valid IANA ID.");
    }

    const candidates = validUtcCandidates(database, timeZone, localTime);
    if (candidates.length === 0) {
      return failure(
        "DST_GAP",
        "This local time did not occur because of a daylight-saving transition.",
      );
    }

    if (candidates.length > 1 && resolution === undefined) {
      return failure(
        "DST_AMBIGUOUS",
        "This local time occurred twice; choose the earlier or later offset.",
      );
    }

    const candidate =
      candidates.length === 1 || resolution === "earlier"
        ? candidates[0]
        : candidates[candidates.length - 1];
    const standardOffsetMinutes = database
      .standardOffset(timeZone, candidate.utcMillis)
      .minutes();

    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        utcIso: new DateTime(candidate.utcMillis, TimeZone.utc()).toUtcIsoString(),
        offsetMinutes: candidate.offsetMinutes,
        dstOffsetMinutes: candidate.offsetMinutes - standardOffsetMinutes,
        standardMeridianLongitude: standardOffsetMinutes / 4,
        resolution: candidates.length > 1 ? resolution ?? null : null,
      }),
    });
  } catch {
    return failure("INVALID_TIME_ZONE", "Time zone could not be resolved.");
  }
}
