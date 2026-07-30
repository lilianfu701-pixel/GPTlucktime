import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import type {
  CalendarDate,
  CalendarError,
  ReligiousCalendarAdapter,
} from "../calendar";

export const GREGORIAN_CALENDAR_ID = "gregorian";

/**
 * Bumped when the rules below change in a way that moves a computed date.
 * Stored with every occurrence so a shift can be explained rather than
 * discovered.
 */
export const GREGORIAN_ADAPTER_VERSION = "1.0.0";

/**
 * Earliest year accepted. Memorials for people born in the nineteenth century
 * are ordinary; dates before the Gregorian reform are not, and quietly applying
 * proleptic arithmetic to them would be a fabrication.
 */
const MIN_YEAR = 1583;
const MAX_YEAR = 2200;

/**
 * What happens to a 29 February anniversary in a common year.
 *
 * `last_day_of_february` observes it on the 28th. Chosen because it keeps the
 * observance in the month the person died, which is what families and civil
 * registries generally do. The alternative — 1 March — moves it out of February
 * entirely.
 *
 * Recorded here as a named, testable decision rather than a side effect of date
 * arithmetic, and named in the adapter version so changing it is visible.
 */
export const LEAP_DAY_POLICY = "last_day_of_february" as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validate(input: CalendarDate): Result<true, CalendarError> {
  if (input.calendarId !== GREGORIAN_CALENDAR_ID) {
    return err("CALENDAR_NOT_CONFIGURED");
  }

  if (
    !Number.isInteger(input.year) ||
    !Number.isInteger(input.month) ||
    !Number.isInteger(input.day)
  ) {
    return err("INVALID_DATE");
  }

  if (input.month < 1 || input.month > 12) {
    return err("INVALID_DATE");
  }

  if (input.day < 1 || input.day > daysInMonth(input.year, input.month)) {
    return err("INVALID_DATE");
  }

  if (input.year < MIN_YEAR || input.year > MAX_YEAR) {
    return err("OUT_OF_RANGE");
  }

  return ok(true);
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = dateTimeFormatters.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  dateTimeFormatters.set(timeZone, formatter);
  return formatter;
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

const HOUR_MS = 60 * 60 * 1000;

/** Compares a rendered local date with a target, as a signed day difference. */
function compareLocalDate(
  local: ZonedParts,
  target: { year: number; month: number; day: number },
): number {
  const a = local.year * 10000 + local.month * 100 + local.day;
  const b = target.year * 10000 + target.month * 100 + target.day;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * The instant a local calendar day begins in a zone.
 *
 * A single offset correction gets close, then the result is verified against the
 * zone and nudged until it genuinely falls on the target local date. The
 * verification is the important part, and it is not defensive padding:
 *
 * Iterating the offset correction is actively wrong where local midnight does
 * not exist. In Havana on 8 March 2026 the clocks jump from 00:00 to 01:00; the
 * offset oscillates between -5 and -4 hours, and a second correction settles on
 * 23:00 on 7 March — the wrong day. So the loop below walks by the hour to the
 * first instant that renders as the requested date, which is 01:00 on a day
 * whose midnight was skipped, and the earlier of the two 00:00s on a day where
 * the clocks go back.
 */
function zonedTimeToInstant(
  target: { year: number; month: number; day: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(target.year, target.month - 1, target.day, 0, 0, 0);

  // One offset correction, which is exact whenever no transition intervenes.
  const atNaive = partsInZone(new Date(naive), timeZone);
  const offset =
    Date.UTC(
      atNaive.year,
      atNaive.month - 1,
      atNaive.day,
      atNaive.hour,
      atNaive.minute,
      atNaive.second,
    ) - naive;

  let instant = new Date(naive - offset);

  // Walk onto the requested local day. A transition can only put us an hour or
  // two out, so the bound is generous rather than meaningful.
  for (let step = 0; step < 48; step += 1) {
    const direction = compareLocalDate(partsInZone(instant, timeZone), target);
    if (direction === 0) {
      break;
    }
    instant = new Date(instant.getTime() + (direction < 0 ? HOUR_MS : -HOUR_MS));
  }

  // Then back to the first hour that is still the requested day, so the result
  // is when the day began rather than some hour within it.
  for (let step = 0; step < 48; step += 1) {
    const earlier = new Date(instant.getTime() - HOUR_MS);
    if (compareLocalDate(partsInZone(earlier, timeZone), target) !== 0) {
      break;
    }
    instant = earlier;
  }

  return instant;
}

/**
 * The day an anniversary falls on in a given year, after the leap-day policy.
 */
function observedDay(
  year: number,
  month: number,
  day: number,
): { month: number; day: number } {
  const available = daysInMonth(year, month);
  if (day <= available) {
    return { month, day };
  }

  // Only 29 February reaches this, and only in a common year.
  return { month, day: available };
}

export const gregorianAdapter: ReligiousCalendarAdapter = {
  id: GREGORIAN_CALENDAR_ID,
  version: GREGORIAN_ADAPTER_VERSION,

  toGregorian(input: CalendarDate): Result<Date, CalendarError> {
    const valid = validate(input);
    if (!valid.ok) {
      return err(valid.error);
    }

    return ok(
      new Date(Date.UTC(input.year, input.month - 1, input.day, 0, 0, 0)),
    );
  },

  nextAnniversary(
    input: CalendarDate,
    after: Date,
    timeZone: string,
  ): Result<Date, CalendarError> {
    const valid = validate(input);
    if (!valid.ok) {
      return err(valid.error);
    }

    // A year-only or approximate date names no day, so there is no anniversary
    // to compute. Doc 05 section 8 forbids inventing one.
    const precision = input.precision ?? "day";
    if (precision !== "day") {
      return err("INSUFFICIENT_PRECISION");
    }

    let localNow: ZonedParts;
    try {
      localNow = partsInZone(after, timeZone);
    } catch {
      // An unrecognized zone identifier. Better to fail than to fall back to
      // UTC and hand a family a date a day out.
      return err("INVALID_DATE");
    }

    for (let year = localNow.year; year <= localNow.year + 5; year += 1) {
      const observed = observedDay(year, input.month, input.day);
      const candidate = zonedTimeToInstant(
        { year, month: observed.month, day: observed.day },
        timeZone,
      );

      // Strictly after: an occurrence that has already begun locally is this
      // year's, and the next one is next year's.
      if (candidate.getTime() > after.getTime()) {
        return ok(candidate);
      }
    }

    return err("OUT_OF_RANGE");
  },
};
