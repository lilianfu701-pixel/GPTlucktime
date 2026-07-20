"use server";

import type { ChartBuildStage } from "../../core/build-chart-context";
import { toChartViewModel, type ChartViewModel } from "../../lib/chart-view-model";
import { checkChartGenerationRateLimit } from "../../server/chart-generation-rate-limit";
import { buildStaticChart } from "../../server/chart-service";

export type GenerateChartResult =
  | Readonly<{ ok: true; viewModel: ChartViewModel }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        stage: ChartBuildStage;
        code: string;
        message: string;
        retryable: boolean;
      }>;
    }>;

/** Server action boundary: calculate once, then expose only the display contract. */
export async function generateChart(input: unknown): Promise<GenerateChartResult> {
  try {
    const rateLimit = await checkChartGenerationRateLimit();
    if (!rateLimit.allowed) {
      return {
        ok: false,
        error: {
          stage: "calculation",
          code: "RATE_LIMITED",
          message: "命盘生成请求过于频繁，请稍后重试。",
          retryable: true,
        },
      };
    }

    const result = buildStaticChart(input);
    if (!result.ok) {
      return {
        ok: false,
        error: {
          ...result.error,
          retryable: result.error.code === "CHART_SERVICE_ERROR",
        },
      };
    }

    return { ok: true, viewModel: toChartViewModel(result.chart) };
  } catch {
    return {
      ok: false,
      error: {
        stage: "calculation",
        code: "GENERATION_UNAVAILABLE",
        message: "命盘暂时无法生成，请稍后重试。",
        retryable: true,
      },
    };
  }
}
