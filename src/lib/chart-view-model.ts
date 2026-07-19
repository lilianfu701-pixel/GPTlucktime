import type {
  ChartContext,
  ChartWarning,
  SolarTermBoundary,
} from "../core/build-chart-context";
import type { Element } from "../core/indicators/elements";
import type { PillarPosition } from "../core/indicators/relations";
import type { ChartVersionKey } from "../core/versions";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

export const CHART_VIEW_GROUP_IDS = Object.freeze([
  "ten-gods",
  "elements",
  "basics",
  "relations",
  "shensha",
  "kyusei",
] as const);

export type ChartViewGroupId = (typeof CHART_VIEW_GROUP_IDS)[number];

export interface ChartViewGroup {
  readonly id: ChartViewGroupId;
  readonly title: string;
  readonly status: "available" | "unavailable";
  readonly message?: string;
  readonly items: readonly JsonObject[];
}

export interface ChartAuditItem {
  readonly id: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly displayValue: string;
}

export interface ChartViewModel {
  readonly summary: Readonly<{
    title: "出生固定盘";
    birthplace: Readonly<{
      name: string;
      latitude: number;
      longitude: number;
    }>;
    localDateTime: string;
    timeZone: string;
    timePrecision: string | null;
  }>;
  readonly pillars: readonly Readonly<{
    position: PillarPosition;
    label: string;
    stem: string;
    branch: string;
    index: number;
    displayValue: string;
  }>[];
  readonly groups: readonly ChartViewGroup[];
  readonly timeAudit: Readonly<{
    items: readonly ChartAuditItem[];
    solarTerms: Readonly<{
      previous: JsonObject;
      current: JsonObject;
      next: JsonObject;
      nearest: JsonObject;
      distanceToNearestSeconds: number;
    }>;
    versions: readonly Readonly<{
      key: ChartVersionKey;
      label: string;
      value: string;
      displayValue: string;
    }>[];
    warnings: readonly JsonObject[];
    provenance: readonly Readonly<{
      id: string;
      ruleId: string;
      versionKey: ChartVersionKey;
      versionValue: string;
    }>[];
    pillarBoundaries: Readonly<{
      year: JsonObject;
      month: JsonObject;
    }>;
  }>;
}

const pillarPositions = ["year", "month", "day", "hour"] as const;
const pillarLabels: Readonly<Record<PillarPosition, string>> = Object.freeze({
  year: "年柱",
  month: "月柱",
  day: "日柱",
  hour: "时柱",
});
const elements = ["wood", "fire", "earth", "metal", "water"] as const;
const elementLabels: Readonly<Record<Element, string>> = Object.freeze({
  wood: "木",
  fire: "火",
  earth: "土",
  metal: "金",
  water: "水",
});
const termLabels: Readonly<Record<string, string>> = Object.freeze({
  lichun: "立春",
  jingzhe: "惊蛰",
  qingming: "清明",
  lixia: "立夏",
  mangzhong: "芒种",
  xiaoshu: "小暑",
  liqiu: "立秋",
  bailu: "白露",
  hanlu: "寒露",
  lidong: "立冬",
  daxue: "大雪",
  xiaohan: "小寒",
});
const versionLabels: Readonly<Record<ChartVersionKey, string>> = Object.freeze({
  application: "应用版本",
  ruleTables: "规则表版本",
  astronomyAlgorithm: "天文算法版本",
  timezoneData: "时区数据版本",
  solarTermAlgorithm: "节气算法版本",
});
const warningDisplay: Readonly<Record<ChartWarning["code"], readonly [string, string]>> =
  Object.freeze({
    TIME_PRECISION_APPROXIMATE: [
      "出生时间精度",
      "出生时间为约略值，边界相关结果存在不确定性",
    ],
    TIME_PRECISION_UNKNOWN: [
      "出生时间精度",
      "出生时间精度未知，边界相关结果存在不确定性",
    ],
    DST_OVERLAP_RESOLVED: [
      "重复民用时间",
      "该民用时间重复出现，已采用用户指定的时刻",
    ],
    NEAR_SOLAR_TERM_BOUNDARY: [
      "节气边界距离",
      "出生时刻接近节气边界",
    ],
    NEAR_TRUE_SOLAR_MIDNIGHT: [
      "真太阳日界距离",
      "真太阳时接近午夜边界",
    ],
    NEAR_DOUBLE_HOUR_BOUNDARY: [
      "时辰边界距离",
      "真太阳时接近双小时边界",
    ],
  });

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function normalizeNumbers<T>(value: T): T {
  if (typeof value === "number") {
    return (Object.is(value, -0) ? 0 : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeNumbers(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalizeNumbers(nested)]),
    ) as T;
  }
  return value;
}

function displayNumber(value: number, unit: string): string {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return `${Object.is(rounded, -0) ? 0 : rounded}${unit}`;
}

function auditItem(
  id: string,
  label: string,
  value: JsonValue,
  displayValue: string,
): ChartAuditItem {
  const normalizedValue =
    typeof value === "number" && Object.is(value, -0) ? 0 : value;
  return { id, label, value: normalizedValue, displayValue };
}

function mapTerm(label: string, term: SolarTermBoundary): JsonObject {
  return {
    label,
    term: term.term,
    termLabel: termLabels[term.term],
    calendarYear: term.calendarYear,
    targetLongitude: term.targetLongitude,
    utcIso: term.utcIso,
    algorithmVersion: term.algorithmVersion,
    displayValue: `${term.calendarYear}年${termLabels[term.term]} ${term.utcIso}`,
  };
}

function mapPillarBoundary(
  label: string,
  boundary: ChartContext["pillars"]["yearBoundary"],
): JsonObject {
  const termLabel = termLabels[boundary.term];
  return {
    label,
    term: boundary.term,
    termLabel,
    utcIso: boundary.utcIso,
    displayValue: `${termLabel} ${boundary.utcIso}`,
  };
}

function mapWarnings(warnings: readonly ChartWarning[]): JsonObject[] {
  return warnings.map((warning) => {
    const [label, displayValue] = warningDisplay[warning.code];
    return {
      code: warning.code,
      label,
      sourceMessage: warning.message,
      displayValue,
      ...(warning.thresholdSeconds === undefined
        ? {}
        : { thresholdSeconds: warning.thresholdSeconds }),
      ...(warning.distanceSeconds === undefined
        ? {}
        : { distanceSeconds: warning.distanceSeconds }),
    };
  });
}

function mapTenGods(chart: ChartContext): ChartViewGroup {
  const records = [
    ...chart.indicators.tenGods.visible,
    ...chart.indicators.tenGods.hidden,
  ];
  const counters = new Map<string, number>();
  const items = records.map((record) => {
    const key = `${record.source}.${record.pillarPosition}`;
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    return {
      id: `${key}.${index}`,
      pillarPosition: record.pillarPosition,
      pillarLabel: pillarLabels[record.pillarPosition],
      stem: record.stem,
      source: record.source,
      sourceLabel: record.source === "visible" ? "显干" : "藏干",
      tenGod: record.tenGod,
    };
  });
  return { id: "ten-gods", title: "十神", status: "available", items };
}

function mapElements(chart: ChartContext): ChartViewGroup {
  const items = (["visible", "hidden"] as const).flatMap((source) =>
    elements.map((element) => ({
      id: `${source}.${element}`,
      source,
      sourceLabel: source === "visible" ? "显干" : "藏干",
      element,
      elementLabel: elementLabels[element],
      count: chart.indicators.elements[source][element],
    })),
  );
  return { id: "elements", title: "五行计数", status: "available", items };
}

function mapBasics(chart: ChartContext): ChartViewGroup {
  const items: JsonObject[] = pillarPositions.map((position) => {
    const pillar = chart.pillars[position];
    const facts = chart.indicators.auxiliary[position];
    return {
      id: position,
      label: pillarLabels[position],
      pillarPosition: position,
      stem: pillar.stem,
      branch: pillar.branch,
      index: pillar.index,
      nayin: facts.nayin.name,
      nayinRuleId: facts.nayin.ruleId,
      xunKong: [...facts.xunKong.voidBranches],
      xunKongRuleId: facts.xunKong.ruleId,
      twelveLifeStage: facts.twelveLifeStage.stage,
      twelveLifeStageRuleId: facts.twelveLifeStage.ruleId,
      displayValue: `${pillar.stem}${pillar.branch}`,
    };
  });
  items.push({
    id: "month-command",
    label: "月令",
    branch: chart.pillars.month.branch,
    boundaryTerm: chart.pillars.monthBoundary.term,
    boundaryTermLabel: termLabels[chart.pillars.monthBoundary.term],
    boundaryUtcIso: chart.pillars.monthBoundary.utcIso,
    displayValue: `${chart.pillars.month.branch}月令`,
  });
  return { id: "basics", title: "基础命盘", status: "available", items };
}

function mapRelations(chart: ChartContext): ChartViewGroup {
  const items = chart.indicators.relations.map((relation, index) => ({
    id: `${relation.ruleId}.${index}`,
    ruleId: relation.ruleId,
    type: relation.type,
    participants: [...relation.participants],
    pillarPositions: [...relation.pillarPositions],
    pillarLabels: relation.pillarPositions.map((position) => pillarLabels[position]),
  }));
  return { id: "relations", title: "干支关系", status: "available", items };
}

function mapKyusei(chart: ChartContext): ChartViewGroup {
  const { natal, month } = chart.indicators.kyusei;
  return {
    id: "kyusei",
    title: "九星气学",
    status: "available",
    items: [
      {
        id: "natal",
        label: "本命星",
        ruleId: natal.ruleId,
        number: natal.star.number,
        name: natal.star.name,
        element: natal.star.element,
      },
      {
        id: "month",
        label: "月命星",
        ruleId: month.ruleId,
        number: month.star.number,
        name: month.star.name,
        element: month.star.element,
      },
    ],
  };
}

function mapTimeAudit(chart: ChartContext): ChartViewModel["timeAudit"] {
  const dstOffsetSeconds = Math.round(chart.civilTime.dstOffsetMinutes * 60);
  const normalizedDstOffsetMinutes = dstOffsetSeconds / 60;
  const dstActive = dstOffsetSeconds !== 0;
  const resolutionDisplay =
    chart.civilTime.resolution === "earlier"
      ? "采用较早一次"
      : chart.civilTime.resolution === "later"
        ? "采用较晚一次"
        : "无需选择";
  const items = [
    auditItem(
      "civil-local",
      "出生地民用时间",
      chart.input.localDateTime,
      chart.input.localDateTime,
    ),
    auditItem("utc", "协调世界时", chart.civilTime.utcIso, chart.civilTime.utcIso),
    auditItem("iana-zone", "IANA 时区", chart.input.timeZone, chart.input.timeZone),
    auditItem(
      "total-offset",
      "总 UTC 偏移",
      chart.civilTime.offsetMinutes,
      displayNumber(chart.civilTime.offsetMinutes, " 分钟"),
    ),
    auditItem(
      "dst-offset",
      "DST 偏移",
      normalizedDstOffsetMinutes,
      `${dstOffsetSeconds} 秒`,
    ),
    auditItem(
      "dst-status",
      "夏令时状态",
      dstActive ? "active" : "inactive",
      dstActive ? "采用夏令时" : "未采用夏令时",
    ),
    auditItem(
      "civil-resolution",
      "重复时刻选择",
      chart.civilTime.resolution,
      resolutionDisplay,
    ),
    auditItem(
      "standard-offset",
      "标准 UTC 偏移",
      chart.civilTime.standardOffsetMinutes,
      displayNumber(chart.civilTime.standardOffsetMinutes, " 分钟"),
    ),
    auditItem(
      "standard-meridian",
      "标准子午线",
      chart.civilTime.standardMeridianLongitude,
      displayNumber(chart.civilTime.standardMeridianLongitude, "°"),
    ),
    auditItem(
      "longitude-correction",
      "经度修正",
      chart.solarTime.longitudeCorrectionSeconds,
      displayNumber(chart.solarTime.longitudeCorrectionSeconds, " 秒"),
    ),
    auditItem(
      "equation-of-time",
      "均时差",
      chart.solarTime.equationOfTimeSeconds,
      displayNumber(chart.solarTime.equationOfTimeSeconds, " 秒"),
    ),
    auditItem(
      "true-solar",
      "真太阳时",
      chart.solarTime.trueSolarIso,
      chart.solarTime.trueSolarIso,
    ),
    auditItem(
      "jdn",
      "儒略日",
      chart.solarTime.jdn,
      displayNumber(chart.solarTime.jdn, ""),
    ),
    auditItem(
      "solar-term-distance",
      "最近节气距离",
      chart.solarTerms.distanceToNearestSeconds,
      displayNumber(chart.solarTerms.distanceToNearestSeconds, " 秒"),
    ),
  ];
  const versionKeys = [
    "application",
    "ruleTables",
    "astronomyAlgorithm",
    "timezoneData",
    "solarTermAlgorithm",
  ] as const;

  return {
    items,
    solarTerms: {
      previous: mapTerm("前一节气", chart.solarTerms.previous),
      current: mapTerm("当前节气", chart.solarTerms.current),
      next: mapTerm("后一节气", chart.solarTerms.next),
      nearest: mapTerm("最近节气", chart.solarTerms.nearest),
      distanceToNearestSeconds: chart.solarTerms.distanceToNearestSeconds,
    },
    versions: versionKeys.map((key) => ({
      key,
      label: versionLabels[key],
      value: chart.versions[key],
      displayValue: chart.versions[key],
    })),
    warnings: mapWarnings(chart.warnings),
    provenance: chart.trace.map(({ id, ruleId, versionKey }) => ({
      id,
      ruleId,
      versionKey,
      versionValue: chart.versions[versionKey],
    })),
    pillarBoundaries: {
      year: mapPillarBoundary("年柱节气边界", chart.pillars.yearBoundary),
      month: mapPillarBoundary("月柱节气边界", chart.pillars.monthBoundary),
    },
  };
}

/** Maps an already-derived static chart to a deterministic display contract. */
export function toChartViewModel(chart: ChartContext): ChartViewModel {
  const pillars = pillarPositions.map((position) => {
    const pillar = chart.pillars[position];
    return {
      position,
      label: pillarLabels[position],
      stem: pillar.stem,
      branch: pillar.branch,
      index: pillar.index,
      displayValue: `${pillar.stem}${pillar.branch}`,
    };
  });

  const viewModel: ChartViewModel = {
    summary: {
      title: "出生固定盘" as const,
      birthplace: {
        name: chart.input.birthplace.name,
        latitude: chart.input.birthplace.latitude,
        longitude: chart.input.birthplace.longitude,
      },
      localDateTime: chart.input.localDateTime,
      timeZone: chart.input.timeZone,
      timePrecision: chart.input.timePrecision ?? null,
    },
    pillars,
    groups: [
      mapTenGods(chart),
      mapElements(chart),
      mapBasics(chart),
      mapRelations(chart),
      {
        id: "shensha" as const,
        title: "神煞",
        status: "unavailable" as const,
        message: "基础神煞规则尚未启用",
        items: [],
      },
      mapKyusei(chart),
    ],
    timeAudit: mapTimeAudit(chart),
  };

  return deepFreeze(normalizeNumbers(viewModel));
}
