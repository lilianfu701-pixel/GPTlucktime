import { utcIsoToJulianDay } from "./calendar/jdn";
import {
  findSolarTerm,
  solarTerms,
  type SolarTerm,
  type SolarTermResult,
} from "./calendar/solar-terms";
import { nayinFor, twelveLifeStageFor, xunKongFor } from "./indicators/auxiliary";
import { countElements } from "./indicators/elements";
import { deriveKyusei } from "./indicators/kyusei";
import {
  PILLAR_POSITIONS,
  deriveRelations,
  type FourPillars,
  type PillarPosition,
} from "./indicators/relations";
import { deriveTenGods } from "./indicators/ten-gods";
import { normalizeBirthInput } from "./input";
import { calculatePillars, type PillarCalculation } from "./pillars/pillars";
import type { EarthlyBranch } from "./pillars/tables";
import { resolveCivilTime, type CivilTimeResult } from "./time/civil-time";
import { calculateSolarTime, type SolarTimeResult } from "./time/solar-time";
import type { NormalizedBirthInput } from "./types";
import { CHART_VERSIONS, type ChartVersionKey } from "./versions";

export const WARNING_THRESHOLDS_SECONDS = Object.freeze({
  solarTerm: 30 * 60,
  trueSolarMidnight: 10 * 60,
  doubleHour: 10 * 60,
} as const);

export type ChartBuildStage = "input" | "civil-time" | "calculation";

export interface TraceItem {
  readonly id: string;
  readonly ruleId: string;
  readonly inputs: unknown;
  readonly output: unknown;
  readonly versionKey: ChartVersionKey;
}

export interface ChartWarning {
  readonly code:
    | "TIME_PRECISION_APPROXIMATE"
    | "TIME_PRECISION_UNKNOWN"
    | "DST_OVERLAP_RESOLVED"
    | "NEAR_SOLAR_TERM_BOUNDARY"
    | "NEAR_TRUE_SOLAR_MIDNIGHT"
    | "NEAR_DOUBLE_HOUR_BOUNDARY";
  readonly message: string;
  readonly thresholdSeconds?: number;
  readonly distanceSeconds?: number;
}

export type ResolvedCivilTime = Extract<CivilTimeResult, { ok: true }>["value"];

export type ChartCivilTime = Readonly<
  ResolvedCivilTime & { readonly standardOffsetMinutes: number }
>;

export interface SolarTermBoundary extends SolarTermResult {
  readonly calendarYear: number;
}

export interface LocatedSolarTerms {
  readonly previous: SolarTermBoundary;
  readonly current: SolarTermBoundary;
  readonly next: SolarTermBoundary;
  readonly nearest: SolarTermBoundary;
  readonly distanceToNearestSeconds: number;
}

type AuxiliaryFacts = Readonly<
  Record<
    PillarPosition,
    Readonly<{
      nayin: ReturnType<typeof nayinFor>;
      xunKong: ReturnType<typeof xunKongFor>;
      twelveLifeStage: ReturnType<typeof twelveLifeStageFor>;
    }>
  >
>;

export interface StaticIndicators {
  readonly tenGods: ReturnType<typeof deriveTenGods>;
  readonly elements: ReturnType<typeof countElements>;
  readonly relations: ReturnType<typeof deriveRelations>;
  readonly auxiliary: AuxiliaryFacts;
  readonly kyusei: ReturnType<typeof deriveKyusei>;
}

export interface ChartContext {
  readonly input: NormalizedBirthInput;
  readonly civilTime: ChartCivilTime;
  readonly solarTime: SolarTimeResult;
  readonly solarTerms: LocatedSolarTerms;
  readonly pillars: PillarCalculation;
  readonly indicators: StaticIndicators;
  readonly trace: readonly TraceItem[];
  readonly warnings: readonly ChartWarning[];
  readonly versions: typeof CHART_VERSIONS;
}

export type ChartContextResult =
  | Readonly<{ ok: true; value: ChartContext }>
  | Readonly<{
      ok: false;
      stage: ChartBuildStage;
      code: string;
      message: string;
    }>;

interface TermEntry extends SolarTermBoundary {
  readonly jdn: number;
}

const secondsPerDay = 86_400;
const minimumSupportedYear = 2;
const maximumSupportedYear = 9998;
const unsupportedDateRangeMessage =
  "Static charts support true-solar years from 0002 through 9998.";

function isSupportedYear(year: number): boolean {
  return year >= minimumSupportedYear && year <= maximumSupportedYear;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }

  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function failure(
  stage: ChartBuildStage,
  code: string,
  message: string,
): ChartContextResult {
  return deepFreeze({ ok: false as const, stage, code, message });
}

function traceItem(
  id: string,
  ruleId: string,
  inputs: unknown,
  output: unknown,
  versionKey: ChartVersionKey,
): TraceItem {
  return { id, ruleId, inputs, output, versionKey };
}

function localYearFromTrueSolarIso(trueSolarIso: string): number {
  return Number(trueSolarIso.slice(0, 4));
}

function buildTermTimeline(localYear: number): readonly TermEntry[] {
  const years = [localYear - 1, localYear, localYear + 1].filter(
    (year) => year >= 1 && year <= 9999,
  );
  return years
    .flatMap((calendarYear) =>
      solarTerms.map((term) => {
        const result = findSolarTerm(calendarYear, term);
        return {
          ...result,
          calendarYear,
          jdn: utcIsoToJulianDay(result.utcIso),
        };
      }),
    )
    .sort((left, right) => left.jdn - right.jdn);
}

function publicBoundary(entry: TermEntry): SolarTermBoundary {
  const { jdn: _jdn, ...boundary } = entry;
  return boundary;
}

function findCurrentTermIndex(
  timeline: readonly TermEntry[],
  birthJdn: number,
): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].jdn <= birthJdn) {
      return index;
    }
  }
  return -1;
}

function locateSolarTerms(
  utcIso: string,
  localYear: number,
): Readonly<{
  located: LocatedSolarTerms;
  boundaryContext: Readonly<Partial<Record<SolarTerm, string>>>;
  solarYear: number;
}> {
  const birthJdn = utcIsoToJulianDay(utcIso);
  const timeline = buildTermTimeline(localYear);
  const currentIndex = findCurrentTermIndex(timeline, birthJdn);
  if (currentIndex < 1 || currentIndex >= timeline.length - 1) {
    throw new RangeError("Adjacent solar terms could not be located.");
  }

  const current = timeline[currentIndex];
  const previous = timeline[currentIndex - 1];
  const next = timeline[currentIndex + 1];
  const currentDistance = Math.abs(birthJdn - current.jdn) * secondsPerDay;
  const nextDistance = Math.abs(next.jdn - birthJdn) * secondsPerDay;
  const nearest = currentDistance <= nextDistance ? current : next;
  const distanceToNearestSeconds = Math.min(currentDistance, nextDistance);
  const localYearEntries = timeline.filter(
    (entry) => entry.calendarYear === localYear,
  );
  const boundaryContext = Object.fromEntries(
    localYearEntries.map((entry) => [entry.term, entry.utcIso]),
  ) as Partial<Record<SolarTerm, string>>;
  const lichun = localYearEntries.find((entry) => entry.term === "lichun");
  if (!lichun) {
    throw new RangeError("Lichun could not be located.");
  }

  return {
    located: {
      previous: publicBoundary(previous),
      current: publicBoundary(current),
      next: publicBoundary(next),
      nearest: publicBoundary(nearest),
      distanceToNearestSeconds,
    },
    boundaryContext,
    solarYear: birthJdn < lichun.jdn ? localYear - 1 : localYear,
  };
}

function fourPillarsFrom(calculation: PillarCalculation): FourPillars {
  return {
    year: calculation.year,
    month: calculation.month,
    day: calculation.day,
    hour: calculation.hour,
  };
}

function deriveAuxiliaryFacts(
  pillars: FourPillars,
): AuxiliaryFacts {
  const entries = PILLAR_POSITIONS.map((position) => {
    const pillar = pillars[position];
    return [
      position,
      {
        nayin: nayinFor(pillar),
        xunKong: xunKongFor(pillar),
        twelveLifeStage: twelveLifeStageFor(
          pillars.day.stem,
          pillar.branch,
        ),
      },
    ] as const;
  });
  return Object.fromEntries(entries) as AuxiliaryFacts;
}

function parseTrueSolarClock(trueSolarIso: string): Readonly<{
  secondsOfDay: number;
}> {
  const match = /T(\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(trueSolarIso);
  if (!match) {
    throw new RangeError("True solar time could not be inspected for warnings.");
  }
  const [, hour, minute, second, millisecond] = match;
  return {
    secondsOfDay:
      Number(hour) * 3600 +
      Number(minute) * 60 +
      Number(second) +
      Number(millisecond) / 1000,
  };
}

function roundedDistance(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function nearestDoubleHourDistance(secondsOfDay: number): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let hour = 1; hour < 24; hour += 2) {
    nearest = Math.min(nearest, Math.abs(secondsOfDay - hour * 3600));
  }
  return nearest;
}

function collectWarnings(
  input: NormalizedBirthInput,
  civilTime: ResolvedCivilTime,
  solarTime: SolarTimeResult,
  locatedTerms: LocatedSolarTerms,
): ChartWarning[] {
  const warnings: ChartWarning[] = [];

  if (input.timePrecision === "approximate") {
    warnings.push({
      code: "TIME_PRECISION_APPROXIMATE",
      message: "Birth time is approximate; boundary-sensitive results may vary.",
    });
  } else if (input.timePrecision === "unknown") {
    warnings.push({
      code: "TIME_PRECISION_UNKNOWN",
      message: "Birth-time precision is unknown; boundary-sensitive results may vary.",
    });
  }

  if (civilTime.resolution !== null) {
    warnings.push({
      code: "DST_OVERLAP_RESOLVED",
      message: "The repeated civil time was resolved using the selected occurrence.",
    });
  }

  if (
    locatedTerms.distanceToNearestSeconds <=
    WARNING_THRESHOLDS_SECONDS.solarTerm
  ) {
    warnings.push({
      code: "NEAR_SOLAR_TERM_BOUNDARY",
      message: "The birth instant is close to a solar-term boundary.",
      thresholdSeconds: WARNING_THRESHOLDS_SECONDS.solarTerm,
      distanceSeconds: roundedDistance(
        locatedTerms.distanceToNearestSeconds,
      ),
    });
  }

  const { secondsOfDay } = parseTrueSolarClock(solarTime.trueSolarIso);
  const midnightDistance = Math.min(
    secondsOfDay,
    secondsPerDay - secondsOfDay,
  );
  if (
    midnightDistance <= WARNING_THRESHOLDS_SECONDS.trueSolarMidnight
  ) {
    warnings.push({
      code: "NEAR_TRUE_SOLAR_MIDNIGHT",
      message: "True solar time is close to midnight; the day boundary is sensitive.",
      thresholdSeconds: WARNING_THRESHOLDS_SECONDS.trueSolarMidnight,
      distanceSeconds: roundedDistance(midnightDistance),
    });
  }

  const doubleHourDistance = nearestDoubleHourDistance(secondsOfDay);
  if (doubleHourDistance <= WARNING_THRESHOLDS_SECONDS.doubleHour) {
    warnings.push({
      code: "NEAR_DOUBLE_HOUR_BOUNDARY",
      message: "True solar time is close to a double-hour boundary.",
      thresholdSeconds: WARNING_THRESHOLDS_SECONDS.doubleHour,
      distanceSeconds: roundedDistance(doubleHourDistance),
    });
  }

  return warnings;
}

/** Builds a deterministic, immutable static chart without exposing user-triggered exceptions. */
export function buildChartContext(input: unknown): ChartContextResult {
  try {
    const normalized = normalizeBirthInput(input);
    if (!normalized.ok) {
      return failure("input", normalized.code, normalized.message);
    }

    const civil = resolveCivilTime(
      normalized.value.localDateTime,
      normalized.value.timeZone,
      normalized.value.civilTimeResolution,
    );
    if (!civil.ok) {
      return failure("civil-time", civil.code, civil.message);
    }

    const civilYear = Number(normalized.value.localDateTime.slice(0, 4));
    if (!isSupportedYear(civilYear)) {
      return failure(
        "calculation",
        "UNSUPPORTED_DATE_RANGE",
        unsupportedDateRangeMessage,
      );
    }
    const standardOffsetMinutes =
      civil.value.offsetMinutes - civil.value.dstOffsetMinutes;
    const chartCivilTime: ChartCivilTime = {
      ...civil.value,
      standardOffsetMinutes,
    };
    const solarTime = calculateSolarTime({
      utcIso: civil.value.utcIso,
      longitude: normalized.value.birthplace.longitude,
      standardMeridianLongitude: civil.value.standardMeridianLongitude,
      birthplaceOffsetMinutes: standardOffsetMinutes,
    });
    const localYear = localYearFromTrueSolarIso(solarTime.trueSolarIso);
    if (!isSupportedYear(localYear)) {
      return failure(
        "calculation",
        "UNSUPPORTED_DATE_RANGE",
        unsupportedDateRangeMessage,
      );
    }
    const termContext = locateSolarTerms(civil.value.utcIso, localYear);
    const pillars = calculatePillars({
      utcIso: civil.value.utcIso,
      trueSolarIso: solarTime.trueSolarIso,
      localYear,
      boundaryContext: { jieUtcIso: termContext.boundaryContext },
    });
    const fourPillars = fourPillarsFrom(pillars);
    const tenGods = deriveTenGods(pillars.day.stem, fourPillars);
    const elements = countElements(fourPillars);
    const relations = deriveRelations(fourPillars);
    const auxiliary = deriveAuxiliaryFacts(fourPillars);
    const kyusei = deriveKyusei({
      solarYear: termContext.solarYear,
      solarMonthBranch: pillars.month.branch as EarthlyBranch,
    });
    const indicators: StaticIndicators = {
      tenGods,
      elements,
      relations,
      auxiliary,
      kyusei,
    };
    const trace: TraceItem[] = [
      traceItem(
        "input.normalize",
        "input.birth.v1",
        normalized.value,
        normalized.value,
        "application",
      ),
      traceItem(
        "time.civil.resolve",
        "time.civil.iana.v1",
        {
          localDateTime: normalized.value.localDateTime,
          timeZone: normalized.value.timeZone,
          resolution: normalized.value.civilTimeResolution ?? null,
        },
        chartCivilTime,
        "timezoneData",
      ),
      traceItem(
        "time.solar.calculate",
        "time.true-solar.v1",
        {
          utcIso: civil.value.utcIso,
          longitude: normalized.value.birthplace.longitude,
          standardMeridianLongitude: civil.value.standardMeridianLongitude,
          birthplaceOffsetMinutes: standardOffsetMinutes,
        },
        solarTime,
        "astronomyAlgorithm",
      ),
      traceItem(
        "calendar.solar-terms.locate",
        "calendar.jie-boundaries.v1",
        { utcIso: civil.value.utcIso, localYear },
        termContext.located,
        "solarTermAlgorithm",
      ),
      traceItem(
        "pillars.calculate",
        "pillars.solar-boundaries.v1",
        {
          utcIso: civil.value.utcIso,
          trueSolarIso: solarTime.trueSolarIso,
          localYear,
        },
        pillars,
        "ruleTables",
      ),
      traceItem(
        "indicators.ten-gods",
        "indicators.ten-gods.v1",
        { dayMaster: pillars.day.stem, pillars: fourPillars },
        tenGods,
        "ruleTables",
      ),
      traceItem(
        "indicators.elements",
        "indicators.elements.v1",
        fourPillars,
        elements,
        "ruleTables",
      ),
      traceItem(
        "indicators.relations",
        "indicators.relations.v1",
        fourPillars,
        relations,
        "ruleTables",
      ),
      traceItem(
        "indicators.auxiliary",
        "indicators.auxiliary.v1",
        fourPillars,
        auxiliary,
        "ruleTables",
      ),
      traceItem(
        "indicators.kyusei",
        "kyusei.natal.v1",
        {
          solarYear: termContext.solarYear,
          solarMonthBranch: pillars.month.branch,
        },
        kyusei,
        "ruleTables",
      ),
    ];
    const warnings = collectWarnings(
      normalized.value,
      civil.value,
      solarTime,
      termContext.located,
    );

    return deepFreeze({
      ok: true as const,
      value: {
        input: normalized.value,
        civilTime: chartCivilTime,
        solarTime,
        solarTerms: termContext.located,
        pillars,
        indicators,
        trace,
        warnings,
        versions: CHART_VERSIONS,
      },
    });
  } catch {
    return failure(
      "calculation",
      "CALCULATION_ERROR",
      "The static chart could not be calculated from the supplied birth details.",
    );
  }
}
