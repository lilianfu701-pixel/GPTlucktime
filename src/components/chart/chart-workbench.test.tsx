import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildChartContext } from "../../core/build-chart-context";
import { toChartViewModel } from "../../lib/chart-view-model";
import { ChartWorkbench } from "./chart-workbench";

afterEach(cleanup);

function chartView(timePrecision: "exact" | "approximate" = "exact") {
  const result = buildChartContext({
    localDateTime: "2024-02-10T12:00:00",
    timeZone: "Etc/UTC",
    birthplace: { name: "Greenwich Birthplace", latitude: 0, longitude: 0 },
    timePrecision,
    residenceContext: {
      name: "RESIDENCE-MUST-NOT-RENDER",
      latitude: 35,
      longitude: 139,
      timeZone: "Asia/Tokyo",
    },
  });
  if (!result.ok) throw new Error(result.message);
  return toChartViewModel(result.value);
}

describe("ChartWorkbench", () => {
  it("renders the four pillars with indexes and marks the day master", () => {
    render(<ChartWorkbench viewModel={chartView()} />);

    expect(screen.getByRole("heading", { name: "四柱命盘", level: 1 })).toBeVisible();
    const grid = screen.getByRole("region", { name: "四柱" });
    expect(within(grid).getAllByLabelText("甲辰")).toHaveLength(2);
    expect(within(grid).getByLabelText("丙寅")).toBeVisible();
    expect(grid.querySelector("[data-pillar='day']")).toHaveTextContent("甲辰");
    expect(within(grid).getByText("日主")).toBeVisible();
    expect(within(grid).getAllByText(/序号/)).toHaveLength(4);
  });

  it("renders six ordered fact groups with honest unavailable and future states", () => {
    render(<ChartWorkbench viewModel={chartView()} />);

    const panel = screen.getByRole("region", { name: "静态指标" });
    const details = within(panel).getAllByRole("group");
    expect(details.map((item) => item.getAttribute("data-group-id"))).toEqual([
      "ten-gods",
      "elements",
      "basics",
      "relations",
      "shensha",
      "kyusei",
    ]);
    expect(details[0]).toHaveAttribute("open");
    expect(details[2]).toHaveAttribute("open");
    expect(within(panel).getAllByText(/比肩/).length).toBeGreaterThan(0);
    expect(within(panel).getByText("三碧木星")).toBeInTheDocument();
    expect(within(panel).getByText("五黄土星")).toBeInTheDocument();
    expect(within(panel).getByText("动态九星（即将推出）")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(panel).getByText("基础神煞规则尚未启用")).toBeInTheDocument();
  });

  it("shows the complete time audit, boundaries, versions, and redacted provenance", () => {
    const { container } = render(<ChartWorkbench viewModel={chartView()} />);

    const audit = screen.getByRole("region", { name: "时间核验" });
    expect(within(audit).getByText("真太阳时")).toBeVisible();
    expect(within(audit).getByText("2024-02-10T11:45:49.108+00:00")).toBeVisible();
    expect(within(audit).getByText("协调世界时")).toBeVisible();
    expect(within(audit).getByText("IANA 时区")).toBeVisible();
    expect(within(audit).getByText("夏令时状态")).toBeVisible();
    expect(within(audit).getByText("标准子午线")).toBeVisible();
    expect(within(audit).getByText("均时差")).toBeVisible();
    expect(within(audit).getByText("儒略日")).toBeVisible();
    expect(within(audit).getByText("当前节气")).toBeVisible();
    expect(within(audit).getByText("历年 2024 · 目标黄经 315°")).toBeVisible();
    expect(
      within(audit).getAllByText("astronomy-engine@2.1.19/search-sun-longitude-v1").length,
    ).toBeGreaterThan(0);
    expect(within(audit).getByText("年柱节气边界")).toBeVisible();
    expect(within(audit).getByText("月柱节气边界")).toBeVisible();
    expect(within(audit).getByText("规则与算法版本")).toBeVisible();
    expect(within(audit).getByText("脱敏推导链")).toBeVisible();
    expect(within(audit).getByText("pillars.solar-boundaries.v1")).toBeVisible();

    const text = container.textContent ?? "";
    expect(text).not.toContain("RESIDENCE-MUST-NOT-RENDER");
    expect(text).not.toMatch(/吉|凶|身强|身弱|喜用|忌/);
  });

  it("keeps warning codes, thresholds, and distances readable", () => {
    render(<ChartWorkbench viewModel={chartView("approximate")} />);

    const audit = screen.getByRole("region", { name: "时间核验" });
    expect(within(audit).getByText("出生时间为约略值，边界相关结果存在不确定性")).toBeVisible();
    expect(within(audit).getByText(/TIME_PRECISION_APPROXIMATE/)).toBeVisible();
  });
});
