import "server-only";

import {
  buildChartContext,
  type ChartBuildStage,
  type ChartContext,
} from "../core/build-chart-context";

export type ChartServiceResult =
  | Readonly<{ ok: true; chart: ChartContext }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        stage: ChartBuildStage;
        code: string;
        message: string;
      }>;
    }>;

function serviceFailure(
  stage: ChartBuildStage,
  code: string,
  message: string,
): ChartServiceResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ stage, code, message }),
  });
}

/** Server-only validation and orchestration boundary for static birth charts. */
export function buildStaticChart(input: unknown): ChartServiceResult {
  try {
    const result = buildChartContext(input);
    if (!result.ok) {
      return serviceFailure(result.stage, result.code, result.message);
    }
    return Object.freeze({ ok: true as const, chart: result.value });
  } catch {
    return serviceFailure(
      "calculation",
      "CHART_SERVICE_ERROR",
      "命盘暂时无法生成，请检查输入后重试。",
    );
  }
}
