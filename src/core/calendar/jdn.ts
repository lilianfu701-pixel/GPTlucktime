const millisecondsPerDay = 86_400_000;

export interface UtcDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const utcIsoPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?Z$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

/** Parses a UTC ISO instant without consulting the host clock or time zone. */
export function parseUtcIso(utcIso: string): UtcDateTimeParts {
  const match = utcIsoPattern.exec(utcIso);
  if (!match) {
    throw new RangeError("UTC instant must be an ISO string ending in Z.");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const parts: UtcDateTimeParts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText ?? "0"),
    millisecond: Number(((fractionText ?? "") + "000").slice(0, 3)),
  };

  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > daysInMonth(parts.year, parts.month) ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    throw new RangeError("UTC instant contains an invalid Gregorian date or time.");
  }

  return parts;
}

/** Returns the astronomical Julian day, whose integer boundary is noon UTC. */
export function utcIsoToJulianDay(utcIso: string): number {
  const parts = parseUtcIso(utcIso);
  return gregorianToJulianDay(parts);
}

export function gregorianToJulianDay(parts: UtcDateTimeParts): number {
  const monthShift = Math.floor((14 - parts.month) / 12);
  const year = parts.year + 4800 - monthShift;
  const month = parts.month + 12 * monthShift - 3;
  const jdnAtNoon =
    parts.day +
    Math.floor((153 * month + 2) / 5) +
    365 * year +
    Math.floor(year / 4) -
    Math.floor(year / 100) +
    Math.floor(year / 400) -
    32045;
  const millisecondsSinceMidnight =
    ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 +
    parts.millisecond;

  return jdnAtNoon - 0.5 + millisecondsSinceMidnight / millisecondsPerDay;
}

function calendarDateFromJdn(jdnAtNoon: number): Pick<UtcDateTimeParts, "year" | "month" | "day"> {
  let l = jdnAtNoon + 68569;
  const n = Math.floor((4 * l) / 146097);
  l -= Math.floor((146097 * n + 3) / 4);
  const i = Math.floor((4000 * (l + 1)) / 1461001);
  l = l - Math.floor((1461 * i) / 4) + 31;
  const j = Math.floor((80 * l) / 2447);
  const day = l - Math.floor((2447 * j) / 80);
  l = Math.floor(j / 11);
  const month = j + 2 - 12 * l;
  const year = 100 * (n - 49) + i + l;

  return { year, month, day };
}

/** Formats a Julian day as a local ISO date-time with an explicit numeric offset. */
export function julianDayToOffsetIso(
  julianDay: number,
  offsetMinutes: number,
): string {
  if (!Number.isFinite(julianDay)) {
    throw new RangeError("Julian day must be a finite number.");
  }
  if (
    !Number.isFinite(offsetMinutes) ||
    offsetMinutes < -1439 ||
    offsetMinutes > 1439
  ) {
    throw new RangeError(
      "UTC offset must be a finite number of minutes between -1439 and 1439.",
    );
  }

  const offsetSeconds = Math.round(offsetMinutes * 60);
  const localJulianDay = julianDay + offsetSeconds / 86_400;
  let jdnAtNoon = Math.floor(localJulianDay + 0.5);
  let milliseconds = Math.round(
    (localJulianDay + 0.5 - jdnAtNoon) * millisecondsPerDay,
  );
  if (milliseconds >= millisecondsPerDay) {
    jdnAtNoon += 1;
    milliseconds -= millisecondsPerDay;
  }

  const date = calendarDateFromJdn(jdnAtNoon);
  if (date.year < 1 || date.year > 9999) {
    throw new RangeError(
      "Julian day cannot be formatted as a four-digit Gregorian year.",
    );
  }
  const hour = Math.floor(milliseconds / 3_600_000);
  milliseconds %= 3_600_000;
  const minute = Math.floor(milliseconds / 60_000);
  milliseconds %= 60_000;
  const second = Math.floor(milliseconds / 1000);
  const millisecond = milliseconds % 1000;
  const sign = offsetSeconds >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetSeconds);
  const offsetHour = Math.floor(absoluteOffset / 3600);
  const offsetMinute = Math.floor((absoluteOffset % 3600) / 60);
  const offsetSecond = absoluteOffset % 60;
  const offsetSuffix = `${sign}${offsetHour
    .toString()
    .padStart(2, "0")}:${offsetMinute.toString().padStart(2, "0")}${
    offsetSecond === 0 ? "" : `:${offsetSecond.toString().padStart(2, "0")}`
  }`;

  return `${date.year.toString().padStart(4, "0")}-${date.month
    .toString()
    .padStart(2, "0")}-${date.day
    .toString()
    .padStart(2, "0")}T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:${second
    .toString()
    .padStart(2, "0")}.${millisecond
    .toString()
    .padStart(3, "0")}${offsetSuffix}`;
}
