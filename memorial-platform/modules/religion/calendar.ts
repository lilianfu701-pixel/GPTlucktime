import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";

/**
 * A date as recorded, in whichever calendar it was given in.
 *
 * `calendarId` is part of the value. A date is meaningless without knowing the
 * system it was counted in, and storing one without the other is how a lunar
 * date silently becomes a Gregorian one.
 */
export type CalendarDate = {
  calendarId: string;
  year: number;
  month: number;
  day: number;
  /** Coarser than `day` means there is no anniversary date to compute. */
  precision?: "day" | "month" | "year" | "approximate" | "unknown";
};

export type CalendarError =
  | "INVALID_DATE"
  | "OUT_OF_RANGE"
  /** The date is not precise enough to name a day. */
  | "INSUFFICIENT_PRECISION"
  /** No adapter is registered. Never substituted with a guess. */
  | "CALENDAR_NOT_CONFIGURED";

/**
 * How one calendar system converts.
 *
 * `version` is recorded alongside every computed anniversary. Calendar rules do
 * get corrected, and a family who was told a date deserves an explanation of why
 * it changed rather than a silent shift.
 */
export interface ReligiousCalendarAdapter {
  readonly id: string;
  readonly version: string;

  toGregorian(input: CalendarDate): Result<Date, CalendarError>;

  /**
   * The next occurrence strictly after `after`, as the instant local midnight
   * begins in `timeZone`.
   *
   * The time zone is not decoration. An anniversary is the same calendar date
   * where the memorial is, so computing it in UTC would move the observance a
   * day for anyone far enough east or west.
   */
  nextAnniversary(
    input: CalendarDate,
    after: Date,
    timeZone: string,
  ): Result<Date, CalendarError>;
}

const adapters = new Map<string, ReligiousCalendarAdapter>();

export function registerCalendarAdapter(
  adapter: ReligiousCalendarAdapter,
): void {
  adapters.set(adapter.id, adapter);
}

export function calendarAdapter(
  calendarId: string,
): Result<ReligiousCalendarAdapter, CalendarError> {
  const adapter = adapters.get(calendarId);
  if (!adapter) {
    // Doc 05 section 8: an unsupported calendar fails explicitly. Falling back
    // to Gregorian arithmetic would present a date nobody computed as though a
    // tradition had been consulted.
    return err("CALENDAR_NOT_CONFIGURED");
  }
  return ok(adapter);
}

export function registeredCalendarIds(): string[] {
  return [...adapters.keys()].sort();
}

/** Test seam. Leaves the built-in registrations in place when called with none. */
export function resetCalendarAdapters(
  keep: readonly ReligiousCalendarAdapter[] = [],
): void {
  adapters.clear();
  for (const adapter of keep) {
    adapters.set(adapter.id, adapter);
  }
}

export type AnniversaryComputation = {
  calendarId: string;
  adapterVersion: string;
  sourceDate: CalendarDate;
  timeZone: string;
  occurrenceAt: Date;
};

/**
 * Computes the next anniversary and records how it was arrived at.
 *
 * The calendar id, the adapter version and the time zone travel with the result
 * so a stored occurrence can be explained, and recomputed the same way, later.
 */
export function nextAnniversaryFor(input: {
  date: CalendarDate;
  after: Date;
  timeZone: string;
}): Result<AnniversaryComputation, CalendarError> {
  const adapter = calendarAdapter(input.date.calendarId);
  if (!adapter.ok) {
    return err(adapter.error);
  }

  const occurrence = adapter.value.nextAnniversary(
    input.date,
    input.after,
    input.timeZone,
  );
  if (!occurrence.ok) {
    return err(occurrence.error);
  }

  return ok({
    calendarId: adapter.value.id,
    adapterVersion: adapter.value.version,
    sourceDate: input.date,
    timeZone: input.timeZone,
    occurrenceAt: occurrence.value,
  });
}
