import {
  gregorianToJulianDay,
  parseUtcIso,
  utcIsoToJulianDay,
} from "../calendar/jdn";
import { findSolarTerm, type SolarTerm } from "../calendar/solar-terms";
import {
  EARTHLY_BRANCHES,
  HEAVENLY_STEMS,
  JIE_TERMS,
  SIXTY_JIA_ZI,
  type Pillar,
} from "./tables";

export interface PillarBoundaryContext {
  readonly jieUtcIso?: Partial<Readonly<Record<SolarTerm, string>>>;
}

export interface CalculatePillarsInput {
  /** Actual birth instant in UTC, used for exact solar-term boundaries. */
  utcIso: string;
  /** True-solar wall time with an explicit numeric UTC offset. */
  trueSolarIso: string;
  /** Gregorian year shown by the true-solar wall time. */
  localYear: number;
  /** Optional precomputed term instants, useful when orchestration already has them. */
  boundaryContext?: PillarBoundaryContext;
}

export interface PillarBoundary {
  readonly term: SolarTerm;
  readonly utcIso: string;
}

export interface PillarCalculation {
  readonly year: Pillar;
  readonly month: Pillar;
  readonly day: Pillar;
  readonly hour: Pillar;
  readonly yearBoundary: PillarBoundary;
  readonly monthBoundary: PillarBoundary;
}

interface ParsedTrueSolarTime {
  readonly localJulianDay: number;
  readonly hour: number;
}

const trueSolarIsoPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:\d{2})$/;
const jiaZiDayAnchorJdnAtNoon = 2_451_551; // 2000-01-07, independently checked as 甲子日.

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function parseTrueSolarTime(value: string): ParsedTrueSolarTime {
  const match = trueSolarIsoPattern.exec(value);
  if (!match) {
    throw new RangeError(
      "True solar time must be an ISO date-time with an explicit UTC offset.",
    );
  }

  const [, localDateTime, offsetText] = match;
  const parts = parseUtcIso(`${localDateTime}Z`);
  const localJulianDay = gregorianToJulianDay({
    ...parts,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const offsetMinutes =
    offsetText === "Z"
      ? 0
      : (offsetText[0] === "-" ? -1 : 1) *
        (Number(offsetText.slice(1, 3)) * 60 + Number(offsetText.slice(4, 6)));

  if (Math.abs(offsetMinutes) > 1439) {
    throw new RangeError("True solar time has an invalid UTC offset.");
  }

  return Object.freeze({
    localJulianDay,
    hour: parts.hour,
  });
}

function pillarAt(index: number): Pillar {
  return SIXTY_JIA_ZI[mod(index, SIXTY_JIA_ZI.length)];
}

function jiaZiIndex(stemIndex: number, branchIndex: number): number {
  const index = SIXTY_JIA_ZI.findIndex(
    (pillar) =>
      pillar.stem === HEAVENLY_STEMS[mod(stemIndex, 10)] &&
      pillar.branch === EARTHLY_BRANCHES[mod(branchIndex, 12)],
  );
  if (index < 0) {
    throw new RangeError("Stem and branch do not form a valid JiaZi pair.");
  }
  return index;
}

function termUtcIso(
  year: number,
  term: SolarTerm,
  context: PillarBoundaryContext | undefined,
  contextYear: number,
): string {
  const provided = year === contextYear ? context?.jieUtcIso?.[term] : undefined;
  return provided ?? findSolarTerm(year, term).utcIso;
}

function termBoundary(
  year: number,
  term: SolarTerm,
  context: PillarBoundaryContext | undefined,
  contextYear: number,
): PillarBoundary {
  return Object.freeze({
    term,
    utcIso: termUtcIso(year, term, context, contextYear),
  });
}

function yearPillar(year: number): Pillar {
  return pillarAt(year - 4);
}

function monthBoundaries(
  cycleYear: number,
  context: PillarBoundaryContext | undefined,
  contextYear: number,
): readonly PillarBoundary[] {
  return Object.freeze(
    JIE_TERMS.map((term, index) =>
      termBoundary(
        term === "xiaohan" ? cycleYear + 1 : cycleYear,
        term,
        context,
        contextYear,
      ),
    ).sort((left, right) => utcIsoToJulianDay(left.utcIso) - utcIsoToJulianDay(right.utcIso)),
  );
}

/** Derives solar-term pillars from the birth instant and day/hour pillars from true solar time. */
export function calculatePillars(input: CalculatePillarsInput): PillarCalculation {
  if (!Number.isInteger(input.localYear) || input.localYear < 1 || input.localYear > 9999) {
    throw new RangeError("Local year must be a four-digit Gregorian year.");
  }

  const trueSolar = parseTrueSolarTime(input.trueSolarIso);
  const birthInstantJulianDay = utcIsoToJulianDay(input.utcIso);
  const currentLichun = termBoundary(
    input.localYear,
    "lichun",
    input.boundaryContext,
    input.localYear,
  );
  const currentLichunJdn = utcIsoToJulianDay(currentLichun.utcIso);
  const cycleYear =
    birthInstantJulianDay < currentLichunJdn
      ? input.localYear - 1
      : input.localYear;
  const year = yearPillar(cycleYear);
  const yearBoundary =
    cycleYear === input.localYear
      ? currentLichun
      : termBoundary(
          cycleYear,
          "lichun",
          input.boundaryContext,
          input.localYear,
        );
  const boundaries = monthBoundaries(
    cycleYear,
    input.boundaryContext,
    input.localYear,
  );
  const monthBoundary =
    [...boundaries]
      .reverse()
      .find(
        (boundary) =>
          utcIsoToJulianDay(boundary.utcIso) <= birthInstantJulianDay,
      ) ?? boundaries[0];
  const monthOrdinal = boundaries.findIndex(
    (boundary) => boundary === monthBoundary,
  );
  const monthStemIndex =
    mod(year.index, HEAVENLY_STEMS.length) * 2 + 2 + monthOrdinal;
  const monthBranchIndex = 2 + monthOrdinal;
  const month = pillarAt(jiaZiIndex(monthStemIndex, monthBranchIndex));

  const dayJdnAtNoon = Math.floor(trueSolar.localJulianDay + 0.5);
  const day = pillarAt(dayJdnAtNoon - jiaZiDayAnchorJdnAtNoon);
  const hourBranchIndex = Math.floor((trueSolar.hour + 1) / 2) % 12;
  const dayStemIndex = day.index % HEAVENLY_STEMS.length;
  const hourStemIndex = dayStemIndex * 2 + hourBranchIndex;
  const hour = pillarAt(jiaZiIndex(hourStemIndex, hourBranchIndex));

  return Object.freeze({
    year,
    month,
    day,
    hour,
    yearBoundary: Object.freeze(yearBoundary),
    monthBoundary: Object.freeze(monthBoundary),
  });
}
