import { beforeEach, describe, expect, it } from "vitest";
import {
  calendarAdapter,
  nextAnniversaryFor,
  registeredCalendarIds,
  resetCalendarAdapters,
} from "@/modules/religion/calendar";
import {
  GREGORIAN_ADAPTER_VERSION,
  LEAP_DAY_POLICY,
  gregorianAdapter,
} from "@/modules/religion/calendars/gregorian";
import { registerBuiltInCalendars } from "@/modules/religion/calendars";

const day = (year: number, month: number, dayOfMonth: number) => ({
  calendarId: "gregorian",
  year,
  month,
  day: dayOfMonth,
  precision: "day" as const,
});

beforeEach(() => {
  resetCalendarAdapters();
  registerBuiltInCalendars();
});

describe("the adapter registry", () => {
  it("registers only calendars the platform can compute", () => {
    // Doc 05 section 8. Everything else must fail explicitly rather than be
    // approximated.
    expect(registeredCalendarIds()).toEqual(["gregorian"]);
  });

  it("reports an unregistered calendar rather than substituting one", () => {
    for (const unsupported of ["hijri", "hebrew", "chinese-lunisolar", "hindu"]) {
      expect(calendarAdapter(unsupported)).toEqual({
        ok: false,
        error: "CALENDAR_NOT_CONFIGURED",
      });
    }
  });

  it("never falls back to Gregorian for an unsupported calendar", () => {
    // The failure that matters: a lunar anniversary quietly computed with solar
    // arithmetic would put a wrong date in front of a family on the one day it
    // matters most.
    const result = nextAnniversaryFor({
      date: { calendarId: "hijri", year: 1441, month: 8, day: 12 },
      after: new Date("2026-01-01T00:00:00Z"),
      timeZone: "UTC",
    });

    expect(result).toEqual({ ok: false, error: "CALENDAR_NOT_CONFIGURED" });
  });
});

describe("Gregorian conversion", () => {
  it("converts a valid date", () => {
    const result = gregorianAdapter.toGregorian(day(1948, 3, 15));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.toISOString()).toBe(
      "1948-03-15T00:00:00.000Z",
    );
  });

  it("accepts 29 February in a leap year", () => {
    expect(gregorianAdapter.toGregorian(day(2020, 2, 29)).ok).toBe(true);
  });

  it("rejects 29 February in a common year", () => {
    expect(gregorianAdapter.toGregorian(day(2021, 2, 29))).toEqual({
      ok: false,
      error: "INVALID_DATE",
    });
  });

  it("knows the century rule", () => {
    // 1900 was not a leap year; 2000 was.
    expect(gregorianAdapter.toGregorian(day(1900, 2, 29)).ok).toBe(false);
    expect(gregorianAdapter.toGregorian(day(2000, 2, 29)).ok).toBe(true);
  });

  it("rejects an impossible day", () => {
    expect(gregorianAdapter.toGregorian(day(2020, 4, 31)).ok).toBe(false);
    expect(gregorianAdapter.toGregorian(day(2020, 13, 1)).ok).toBe(false);
    expect(gregorianAdapter.toGregorian(day(2020, 0, 1)).ok).toBe(false);
    expect(gregorianAdapter.toGregorian(day(2020, 1, 0)).ok).toBe(false);
  });

  it("rejects a non-integer component", () => {
    expect(
      gregorianAdapter.toGregorian({
        calendarId: "gregorian",
        year: 2020,
        month: 1.5,
        day: 1,
      }).ok,
    ).toBe(false);
  });

  it("refuses a year before the Gregorian reform", () => {
    // Applying proleptic arithmetic to a Julian date would be a fabrication.
    expect(gregorianAdapter.toGregorian(day(1500, 6, 1))).toEqual({
      ok: false,
      error: "OUT_OF_RANGE",
    });
  });

  it("refuses a date another calendar was recorded in", () => {
    expect(
      gregorianAdapter.toGregorian({
        calendarId: "hebrew",
        year: 5780,
        month: 1,
        day: 1,
      }),
    ).toEqual({ ok: false, error: "CALENDAR_NOT_CONFIGURED" });
  });
});

describe("the next anniversary", () => {
  it("is this year's occurrence when it is still ahead", () => {
    const result = gregorianAdapter.nextAnniversary(
      day(2020, 3, 15),
      new Date("2026-01-10T00:00:00Z"),
      "UTC",
    );

    expect(result.ok && result.value.toISOString()).toBe(
      "2026-03-15T00:00:00.000Z",
    );
  });

  it("is next year's once this year's has begun", () => {
    const result = gregorianAdapter.nextAnniversary(
      day(2020, 3, 15),
      new Date("2026-03-15T00:00:00Z"),
      "UTC",
    );

    // Strictly after: the day that has already started is not still to come.
    expect(result.ok && result.value.toISOString()).toBe(
      "2027-03-15T00:00:00.000Z",
    );
  });

  it("is still today's occurrence a moment before it begins", () => {
    const result = gregorianAdapter.nextAnniversary(
      day(2020, 3, 15),
      new Date("2026-03-14T23:59:59Z"),
      "UTC",
    );

    expect(result.ok && result.value.toISOString()).toBe(
      "2026-03-15T00:00:00.000Z",
    );
  });

  it("is not computed by adding 365 days", () => {
    // Doc 05 section 8 names this explicitly. Across a leap year the naive sum
    // drifts to the day before.
    const result = gregorianAdapter.nextAnniversary(
      day(2020, 3, 15),
      new Date("2024-03-16T00:00:00Z"),
      "UTC",
    );

    expect(result.ok && result.value.toISOString()).toBe(
      "2025-03-15T00:00:00.000Z",
    );

    const naive = new Date(
      new Date("2024-03-15T00:00:00Z").getTime() + 365 * 24 * 60 * 60 * 1000,
    );
    expect(naive.toISOString()).toBe("2025-03-15T00:00:00.000Z");

    // And the other direction: 2024 is a leap year, so a 2023 anniversary plus
    // 365 days lands a day early.
    const across = gregorianAdapter.nextAnniversary(
      day(2020, 3, 15),
      new Date("2023-03-16T00:00:00Z"),
      "UTC",
    );
    const naiveAcross = new Date(
      new Date("2023-03-15T00:00:00Z").getTime() + 365 * 24 * 60 * 60 * 1000,
    );
    expect(across.ok && across.value.toISOString()).toBe(
      "2024-03-15T00:00:00.000Z",
    );
    expect(naiveAcross.toISOString()).toBe("2024-03-14T00:00:00.000Z");
  });
});

describe("29 February anniversaries", () => {
  it("fall on the 29th in a leap year", () => {
    const result = gregorianAdapter.nextAnniversary(
      day(2020, 2, 29),
      new Date("2024-01-01T00:00:00Z"),
      "UTC",
    );

    expect(result.ok && result.value.toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("fall on the last day of February in a common year", () => {
    // The named policy: stay in the month the person died, rather than moving
    // the observance into March.
    expect(LEAP_DAY_POLICY).toBe("last_day_of_february");

    const result = gregorianAdapter.nextAnniversary(
      day(2020, 2, 29),
      new Date("2025-01-01T00:00:00Z"),
      "UTC",
    );

    expect(result.ok && result.value.toISOString()).toBe(
      "2025-02-28T00:00:00.000Z",
    );
  });

  it("never move into March", () => {
    for (const year of [2025, 2026, 2027]) {
      const result = gregorianAdapter.nextAnniversary(
        day(2020, 2, 29),
        new Date(`${year}-01-01T00:00:00Z`),
        "UTC",
      );
      expect(result.ok && result.value.toISOString().slice(5, 7)).toBe("02");
    }
  });
});

describe("time zones", () => {
  it("resolve to local midnight where the memorial is", () => {
    // An anniversary is the same calendar date where the memorial is. Computing
    // it in UTC would move the observance a day for anyone far enough east.
    const auckland = gregorianAdapter.nextAnniversary(
      day(2020, 3, 15),
      new Date("2026-01-01T00:00:00Z"),
      "Pacific/Auckland",
    );

    // Auckland is UTC+13 in March, so local midnight is the previous day in UTC.
    expect(auckland.ok && auckland.value.toISOString()).toBe(
      "2026-03-14T11:00:00.000Z",
    );
  });

  it("differ between zones for the same calendar date", () => {
    const utc = gregorianAdapter.nextAnniversary(
      day(2020, 3, 15),
      new Date("2026-01-01T00:00:00Z"),
      "UTC",
    );
    const losAngeles = gregorianAdapter.nextAnniversary(
      day(2020, 3, 15),
      new Date("2026-01-01T00:00:00Z"),
      "America/Los_Angeles",
    );

    expect(utc.ok && losAngeles.ok).toBe(true);
    if (!utc.ok || !losAngeles.ok) return;
    expect(losAngeles.value.getTime()).toBeGreaterThan(utc.value.getTime());
  });

  it("land on local midnight even when the clocks move that day", () => {
    // 29 March 2026 is when European clocks go forward. A single-pass offset
    // correction lands an hour out here.
    const result = gregorianAdapter.nextAnniversary(
      day(2010, 3, 29),
      new Date("2026-01-01T00:00:00Z"),
      "Europe/Berlin",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      hourCycle: "h23",
    }).format(result.value);

    expect(local).toContain("00:00");
    expect(local).toContain("29/03");
  });

  it("land on local midnight in a half-hour offset zone", () => {
    const result = gregorianAdapter.nextAnniversary(
      day(2015, 6, 10),
      new Date("2026-01-01T00:00:00Z"),
      "Asia/Kolkata",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // UTC+05:30, so local midnight is 18:30 UTC the previous day.
    expect(result.value.toISOString()).toBe("2026-06-09T18:30:00.000Z");
  });

  it("land on the right day where local midnight does not exist", () => {
    // Havana moves the clocks from 00:00 to 01:00 on 8 March 2026, so that day
    // has no midnight. The day begins at 01:00, and the result must not slide
    // back to the 7th — which is exactly what iterating the offset correction
    // does here, because the offset oscillates between -5 and -4 hours.
    const result = gregorianAdapter.nextAnniversary(
      day(2012, 3, 8),
      new Date("2026-01-01T00:00:00Z"),
      "America/Havana",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Havana",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(result.value);

    expect(local).toContain("08/03");
    expect(local).toContain("01:00");
  });

  it("take the first of two local midnights where the clocks go back", () => {
    // Havana repeats 00:00 on 1 November 2026. The day began at the first one.
    const result = gregorianAdapter.nextAnniversary(
      day(2012, 11, 1),
      new Date("2026-01-01T00:00:00Z"),
      "America/Havana",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("refuse an unrecognized zone rather than assuming UTC", () => {
    expect(
      gregorianAdapter.nextAnniversary(
        day(2020, 3, 15),
        new Date("2026-01-01T00:00:00Z"),
        "Mars/Olympus_Mons",
      ),
    ).toEqual({ ok: false, error: "INVALID_DATE" });
  });
});

describe("imprecise dates", () => {
  it("produce no anniversary at all", () => {
    // A year-only date names no day. Choosing one would be an invention.
    for (const precision of ["month", "year", "approximate", "unknown"] as const) {
      expect(
        gregorianAdapter.nextAnniversary(
          { calendarId: "gregorian", year: 1948, month: 1, day: 1, precision },
          new Date("2026-01-01T00:00:00Z"),
          "UTC",
        ),
      ).toEqual({ ok: false, error: "INSUFFICIENT_PRECISION" });
    }
  });

  it("treat an unstated precision as a full date", () => {
    expect(
      gregorianAdapter.nextAnniversary(
        { calendarId: "gregorian", year: 1948, month: 3, day: 15 },
        new Date("2026-01-01T00:00:00Z"),
        "UTC",
      ).ok,
    ).toBe(true);
  });
});

describe("what a computed anniversary records", () => {
  it("carries the calendar, the adapter version and the zone", () => {
    // A family told a date deserves an explanation if it later changes, so the
    // rules used are stored with the result.
    const result = nextAnniversaryFor({
      date: day(2020, 3, 15),
      after: new Date("2026-01-01T00:00:00Z"),
      timeZone: "Asia/Tokyo",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.calendarId).toBe("gregorian");
    expect(result.value.adapterVersion).toBe(GREGORIAN_ADAPTER_VERSION);
    expect(result.value.timeZone).toBe("Asia/Tokyo");
    expect(result.value.sourceDate).toEqual(day(2020, 3, 15));
  });

  it("propagates a failure without inventing an occurrence", () => {
    const result = nextAnniversaryFor({
      date: { calendarId: "gregorian", year: 1948, month: 1, day: 1, precision: "year" },
      after: new Date("2026-01-01T00:00:00Z"),
      timeZone: "UTC",
    });

    expect(result).toEqual({ ok: false, error: "INSUFFICIENT_PRECISION" });
  });
});
