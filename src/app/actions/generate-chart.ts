"use server";

import type { ChartBuildStage } from "../../core/build-chart-context";
import { toChartViewModel, type ChartViewModel } from "../../lib/chart-view-model";
import { buildStaticChart } from "../../server/chart-service";

export type GenerateChartResult =
  | Readonly<{ ok: true; viewModel: ChartViewModel }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        stage: ChartBuildStage;
        code: string;
        message: string;
      }>;
    }>;

/** Server action boundary: calculate once, then expose only the display contract. */
export async function generateChart(input: unknown): Promise<GenerateChartResult> {
  try {
    const result = buildStaticChart(input);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, viewModel: toChartViewModel(result.chart) };
  } catch {
    return {
      ok: false,
      error: {
        stage: "calculation",
        code: "GENERATION_UNAVAILABLE",
        message: "命盘暂时无法生成，请稍后重试。",
      },
    };
  }
}
