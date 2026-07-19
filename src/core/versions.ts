export const CHART_VERSIONS = Object.freeze({
  application: "gptlucktime@0.1.0/chart-context-v1",
  ruleTables: "bazi-static-rules@1.0.0",
  astronomyAlgorithm: "astronomy-engine@2.1.19/true-solar-time-v1",
  timezoneData: "timezonecomplete@5.15.1/tzdata@1.0.49",
  solarTermAlgorithm: "astronomy-engine@2.1.19/search-sun-longitude-v1",
} as const);

export type ChartVersionKey = keyof typeof CHART_VERSIONS;
