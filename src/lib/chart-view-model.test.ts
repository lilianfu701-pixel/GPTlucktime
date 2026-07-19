import { describe, expect, it } from "vitest";

import { buildChartContext, type ChartContext } from "../core/build-chart-context";
import { toChartViewModel } from "./chart-view-model";

const residenceMarker = "RESIDENCE-MUST-NOT-LEAK-OSAKA";
const input = {
  localDateTime: "2024-02-10T12:00:00",
  timeZone: "Etc/UTC",
  birthplace: {
    name: "Greenwich Birthplace",
    latitude: 0,
    longitude: 0,
  },
  timePrecision: "exact" as const,
  residenceContext: {
    name: residenceMarker,
    latitude: 34.6937,
    longitude: 135.5023,
    timeZone: "Asia/Tokyo",
  },
};

function chartFor(value: unknown = input): ChartContext {
  const result = buildChartContext(value);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`Expected chart success: ${result.code}`);
  return result.value;
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeepFrozen(nested, seen);
}

function expectNoNegativeZero(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === "number") {
    expect(Object.is(value, -0)).toBe(false);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) expectNoNegativeZero(nested, seen);
}

describe("toChartViewModel", () => {
  it("maps fixed summary, pillars, and ordered display groups", () => {
    const viewModel = toChartViewModel(chartFor());

    expect(viewModel.summary).toEqual({
      title: "出生固定盘",
      birthplace: {
        name: "Greenwich Birthplace",
        latitude: 0,
        longitude: 0,
      },
      localDateTime: "2024-02-10T12:00:00",
      timeZone: "Etc/UTC",
      timePrecision: "exact",
    });
    expect(viewModel.pillars).toEqual([
      {
        position: "year",
        label: "年柱",
        stem: "甲",
        branch: "辰",
        index: 40,
        displayValue: "甲辰",
      },
      {
        position: "month",
        label: "月柱",
        stem: "丙",
        branch: "寅",
        index: 2,
        displayValue: "丙寅",
      },
      expect.objectContaining({ position: "day", label: "日柱", index: 40 }),
      expect.objectContaining({ position: "hour", label: "时柱", index: 6 }),
    ]);
    expect(viewModel.groups.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "ten-gods", title: "十神" },
      { id: "elements", title: "五行计数" },
      { id: "basics", title: "基础命盘" },
      { id: "relations", title: "干支关系" },
      { id: "shensha", title: "神煞" },
      { id: "kyusei", title: "九星气学" },
    ]);
  });

  it("maps all audited static indicator facts without interpretation", () => {
    const viewModel = toChartViewModel(chartFor());
    const tenGods = viewModel.groups.find((group) => group.id === "ten-gods");
    const elements = viewModel.groups.find((group) => group.id === "elements");
    const basics = viewModel.groups.find((group) => group.id === "basics");
    const relations = viewModel.groups.find((group) => group.id === "relations");
    const shensha = viewModel.groups.find((group) => group.id === "shensha");
    const kyusei = viewModel.groups.find((group) => group.id === "kyusei");

    expect(tenGods).toMatchObject({
      status: "available",
      items: expect.arrayContaining([
        {
          id: "visible.year.0",
          pillarPosition: "year",
          pillarLabel: "年柱",
          stem: "甲",
          source: "visible",
          sourceLabel: "显干",
          tenGod: "比肩",
        },
        {
          id: "hidden.month.0",
          pillarPosition: "month",
          pillarLabel: "月柱",
          stem: "甲",
          source: "hidden",
          sourceLabel: "藏干",
          tenGod: "比肩",
        },
      ]),
    });
    expect(elements).toMatchObject({
      status: "available",
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "visible.wood",
          source: "visible",
          element: "wood",
          count: 2,
        }),
        expect.objectContaining({
          id: "hidden.earth",
          source: "hidden",
          element: "earth",
          count: 4,
        }),
      ]),
    });
    expect(basics).toMatchObject({
      status: "available",
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "year",
          pillarPosition: "year",
          index: 40,
          nayin: "覆灯火",
          xunKong: ["寅", "卯"],
          twelveLifeStage: "衰",
        }),
        expect.objectContaining({
          id: "month-command",
          label: "月令",
          branch: "寅",
          boundaryTerm: "lichun",
        }),
      ]),
    });
    expect(relations).toMatchObject({
      status: "available",
      items: expect.arrayContaining([
        expect.objectContaining({
          ruleId: expect.any(String),
          type: expect.any(String),
          participants: expect.any(Array),
          pillarPositions: expect.any(Array),
        }),
      ]),
    });
    expect(shensha).toEqual({
      id: "shensha",
      title: "神煞",
      status: "unavailable",
      message: "基础神煞规则尚未启用",
      items: [],
    });
    expect(kyusei).toEqual({
      id: "kyusei",
      title: "九星气学",
      status: "available",
      items: [
        {
          id: "natal",
          label: "本命星",
          ruleId: "kyusei.natal.v1",
          number: 3,
          name: "三碧木星",
          element: "wood",
        },
        {
          id: "month",
          label: "月命星",
          ruleId: "kyusei.month.v1",
          number: 5,
          name: "五黄土星",
          element: "earth",
        },
      ],
    });

    const json = JSON.stringify(viewModel);
    expect(json).not.toMatch(/吉|凶|身强|身弱|喜用|忌|interpretation/);
  });

  it("maps a complete machine-readable time audit with Chinese display labels", () => {
    const viewModel = toChartViewModel(chartFor());
    const byId = Object.fromEntries(
      viewModel.timeAudit.items.map((item) => [item.id, item]),
    );

    expect(byId).toMatchObject({
      "civil-local": {
        label: "出生地民用时间",
        value: "2024-02-10T12:00:00",
        displayValue: "2024-02-10T12:00:00",
      },
      utc: {
        label: "协调世界时",
        value: "2024-02-10T12:00:00.000Z",
        displayValue: "2024-02-10T12:00:00.000Z",
      },
      "iana-zone": {
        label: "IANA 时区",
        value: "Etc/UTC",
        displayValue: "Etc/UTC",
      },
      "total-offset": { label: "总 UTC 偏移", value: 0, displayValue: "0 分钟" },
      "dst-offset": { label: "DST 偏移", value: 0, displayValue: "0 秒" },
      "dst-status": { label: "夏令时状态", value: "inactive", displayValue: "未采用夏令时" },
      "standard-offset": { label: "标准 UTC 偏移", value: 0, displayValue: "0 分钟" },
      "standard-meridian": { label: "标准子午线", value: 0, displayValue: "0°" },
      "longitude-correction": expect.objectContaining({ label: "经度修正", value: 0 }),
      "equation-of-time": expect.objectContaining({ label: "均时差", value: expect.any(Number) }),
      "true-solar": expect.objectContaining({ label: "真太阳时", value: expect.any(String) }),
      jdn: expect.objectContaining({ label: "儒略日", value: expect.any(Number) }),
      "solar-term-distance": {
        label: "最近节气距离",
        value: expect.any(Number),
        displayValue: expect.stringMatching(/ 秒$/),
      },
    });
    expect(viewModel.timeAudit.solarTerms).toMatchObject({
      previous: { label: "前一节气", term: "xiaohan", calendarYear: 2024 },
      current: { label: "当前节气", term: "lichun", calendarYear: 2024 },
      next: { label: "后一节气", term: "jingzhe", calendarYear: 2024 },
      nearest: { term: expect.any(String), utcIso: expect.any(String) },
      distanceToNearestSeconds: expect.any(Number),
    });
    expect(viewModel.timeAudit.versions.map((item) => item.key)).toEqual([
      "application",
      "ruleTables",
      "astronomyAlgorithm",
      "timezoneData",
      "solarTermAlgorithm",
    ]);
    expect(viewModel.timeAudit.pillarBoundaries).toEqual({
      year: {
        label: "年柱节气边界",
        term: "lichun",
        termLabel: "立春",
        utcIso: "2024-02-04T08:26:49.630Z",
        displayValue: "立春 2024-02-04T08:26:49.630Z",
      },
      month: {
        label: "月柱节气边界",
        term: "lichun",
        termLabel: "立春",
        utcIso: "2024-02-04T08:26:49.630Z",
        displayValue: "立春 2024-02-04T08:26:49.630Z",
      },
    });
  });

  it("maps a redacted ten-step provenance chain with resolved versions", () => {
    const viewModel = toChartViewModel(chartFor());

    expect(viewModel.timeAudit.provenance).toEqual([
      {
        id: "input.normalize",
        ruleId: "input.birth.v1",
        versionKey: "application",
        versionValue: "gptlucktime@0.1.0/chart-context-v1",
      },
      {
        id: "time.civil.resolve",
        ruleId: "time.civil.iana.v1",
        versionKey: "timezoneData",
        versionValue: "timezonecomplete@5.15.1/tzdata@1.0.49",
      },
      {
        id: "time.solar.calculate",
        ruleId: "time.true-solar.v1",
        versionKey: "astronomyAlgorithm",
        versionValue: "astronomy-engine@2.1.19/true-solar-time-v1",
      },
      {
        id: "calendar.solar-terms.locate",
        ruleId: "calendar.jie-boundaries.v1",
        versionKey: "solarTermAlgorithm",
        versionValue: "astronomy-engine@2.1.19/search-sun-longitude-v1",
      },
      {
        id: "pillars.calculate",
        ruleId: "pillars.solar-boundaries.v1",
        versionKey: "ruleTables",
        versionValue: "bazi-static-rules@1.0.0",
      },
      {
        id: "indicators.ten-gods",
        ruleId: "indicators.ten-gods.v1",
        versionKey: "ruleTables",
        versionValue: "bazi-static-rules@1.0.0",
      },
      {
        id: "indicators.elements",
        ruleId: "indicators.elements.v1",
        versionKey: "ruleTables",
        versionValue: "bazi-static-rules@1.0.0",
      },
      {
        id: "indicators.relations",
        ruleId: "indicators.relations.v1",
        versionKey: "ruleTables",
        versionValue: "bazi-static-rules@1.0.0",
      },
      {
        id: "indicators.auxiliary",
        ruleId: "indicators.auxiliary.v1",
        versionKey: "ruleTables",
        versionValue: "bazi-static-rules@1.0.0",
      },
      {
        id: "indicators.kyusei",
        ruleId: "kyusei.natal.v1",
        versionKey: "ruleTables",
        versionValue: "bazi-static-rules@1.0.0",
      },
    ]);

    const json = JSON.stringify(viewModel.timeAudit.provenance);
    expect(json).not.toContain("inputs");
    expect(json).not.toContain("output");
    expect(json).not.toContain(residenceMarker);
  });

  it("maps DST status and warnings without dropping machine values", () => {
    const chart = chartFor({
      localDateTime: "2024-06-01T00:00:00",
      timeZone: "America/New_York",
      birthplace: { name: "New York", latitude: 40.7128, longitude: -74.006 },
      timePrecision: "approximate",
    });
    const viewModel = toChartViewModel(chart);
    const dstStatus = viewModel.timeAudit.items.find((item) => item.id === "dst-status");

    expect(dstStatus).toEqual({
      id: "dst-status",
      label: "夏令时状态",
      value: "active",
      displayValue: "采用夏令时",
    });
    expect(viewModel.timeAudit.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TIME_PRECISION_APPROXIMATE",
          label: "出生时间精度",
          displayValue: "出生时间为约略值，边界相关结果存在不确定性",
        }),
      ]),
    );
  });

  it("treats sub-second Shanghai LMT residue as inactive DST", () => {
    const chart = chartFor({
      localDateTime: "1900-06-15T12:00:00",
      timeZone: "Asia/Shanghai",
      birthplace: { name: "Shanghai", latitude: 31.2304, longitude: 121.4737 },
      timePrecision: "exact",
    });
    const viewModel = toChartViewModel(chart);
    const byId = Object.fromEntries(
      viewModel.timeAudit.items.map((item) => [item.id, item]),
    );

    expect(chart.civilTime.dstOffsetMinutes).not.toBe(0);
    expect(byId["dst-offset"]).toEqual({
      id: "dst-offset",
      label: "DST 偏移",
      value: 0,
      displayValue: "0 秒",
    });
    expect(byId["dst-status"]).toEqual({
      id: "dst-status",
      label: "夏令时状态",
      value: "inactive",
      displayValue: "未采用夏令时",
    });
  });

  it("normalizes negative zero recursively before freezing", () => {
    const chart = chartFor({
      ...input,
      birthplace: {
        name: "Zero Meridian",
        latitude: -0,
        longitude: -0,
      },
    });
    const viewModel = toChartViewModel(chart);

    expect(viewModel.summary.birthplace).toEqual({
      name: "Zero Meridian",
      latitude: 0,
      longitude: 0,
    });
    expectNoNegativeZero(viewModel);
    expect(JSON.parse(JSON.stringify(viewModel))).toEqual(viewModel);
    expectDeepFrozen(viewModel);
  });

  it("is deterministic, JSON serializable, deeply frozen, and excludes residence context", () => {
    const chart = chartFor();
    const first = toChartViewModel(chart);
    const second = toChartViewModel(chart);
    const json = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(JSON.parse(json)).toEqual(first);
    expect(json).not.toContain(residenceMarker);
    expect(json).not.toContain("residenceContext");
    expect(first.summary.birthplace).not.toBe(chart.input.birthplace);
    expectDeepFrozen(first);
  });
});
