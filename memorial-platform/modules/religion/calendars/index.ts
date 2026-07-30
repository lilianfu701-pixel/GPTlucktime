import { registerCalendarAdapter } from "../calendar";
import { gregorianAdapter } from "./gregorian";

/**
 * Registers the calendars the platform can actually compute.
 *
 * Gregorian only. Doc 05 section 8 requires the others to fail explicitly with
 * CALENDAR_NOT_CONFIGURED until an adapter exists that a reviewer has checked.
 * Adding one here is the whole change: no caller needs to know which calendars
 * are supported.
 *
 * Deliberately not registered, and not approximated:
 *
 * - Hijri, whose observance depends on local sighting as well as calculation;
 * - Hebrew, with its leap months and postponement rules;
 * - the Chinese and Vietnamese lunisolar calendars;
 * - the Hindu calendars, which vary by region and by tradition.
 *
 * Each needs a reviewed implementation. Approximating any of them would put a
 * wrong date in front of a family on the one day it matters most.
 */
export function registerBuiltInCalendars(): void {
  registerCalendarAdapter(gregorianAdapter);
}

export { gregorianAdapter, GREGORIAN_CALENDAR_ID } from "./gregorian";
