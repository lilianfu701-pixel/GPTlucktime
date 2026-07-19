import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Home from "../../app/page";
import {
  ChartSessionProvider,
  useChartSession,
} from "../chart-session-provider";
import { BirthIntakeForm } from "./birth-intake-form";

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

interface BirthFieldValues {
  date?: string;
  time?: string;
  name?: string;
  latitude?: string;
  longitude?: string;
  timeZone?: string;
}

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillRequiredFields(values: BirthFieldValues = {}): void {
  change("出生日期", values.date ?? "1990-06-15");
  change("出生时间（可含秒）", values.time ?? "14:30:45");
  change("出生地名称", values.name ?? "上海");
  change("出生地纬度", values.latitude ?? "31.2304");
  change("出生地经度", values.longitude ?? "121.4737");
  change("出生地 IANA 时区", values.timeZone ?? "Asia/Shanghai");
}

function SessionProbe() {
  const { pendingBirthInput } = useChartSession();
  return (
    <output data-testid="pending-birth-input">
      {pendingBirthInput ? JSON.stringify(pendingBirthInput) : ""}
    </output>
  );
}

function renderIntake(ui = <BirthIntakeForm />) {
  return render(
    <ChartSessionProvider>
      {ui}
      <SessionProbe />
    </ChartSessionProvider>,
  );
}

function pendingInput(): Record<string, unknown> | null {
  const serialized = screen.getByTestId("pending-birth-input").textContent;
  return serialized ? (JSON.parse(serialized) as Record<string, unknown>) : null;
}

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BirthIntakeForm", () => {
  it("starts disabled and enables only after all required fields validate", () => {
    renderIntake();
    const submit = screen.getByRole("button", { name: "校验时间并生成命盘" });

    expect(submit).toBeDisabled();
    fillRequiredFields();
    expect(submit).toBeEnabled();
  });

  it("associates required and coordinate errors with their fields", async () => {
    const user = userEvent.setup();
    renderIntake();
    const birthplace = screen.getByLabelText("出生地名称");
    const latitude = screen.getByLabelText("出生地纬度");

    await user.click(birthplace);
    await user.tab();
    expect(birthplace).toHaveAttribute("aria-invalid", "true");
    expect(birthplace).toHaveAccessibleDescription("请输入出生地名称");

    change("出生地纬度", "91");
    fireEvent.blur(latitude);
    expect(latitude).toHaveAttribute("aria-invalid", "true");
    expect(latitude).toHaveAccessibleDescription("纬度必须在 -90 到 90 之间");
  });

  it("blocks a New York daylight-saving gap and associates the error with date and time", () => {
    renderIntake();
    fillRequiredFields({
      date: "2024-03-10",
      time: "02:30:00",
      name: "纽约",
      latitude: "40.7128",
      longitude: "-74.006",
      timeZone: "America/New_York",
    });

    const date = screen.getByLabelText("出生日期");
    const time = screen.getByLabelText("出生时间（可含秒）");
    expect(screen.getByRole("button", { name: "校验时间并生成命盘" })).toBeDisabled();
    expect(date).toHaveAttribute("aria-invalid", "true");
    expect(time).toHaveAttribute("aria-invalid", "true");
    expect(date).toHaveAccessibleDescription(/因夏令时切换而不存在/);
    expect(time).toHaveAccessibleDescription(/因夏令时切换而不存在/);
  });

  it.each(["earlier", "later"] as const)(
    "requires and accepts the %s resolution for a New York daylight-saving overlap",
    async (resolution) => {
      const user = userEvent.setup();
      renderIntake();
      fillRequiredFields({
        date: "2024-11-03",
        time: "01:30:00",
        name: "纽约",
        latitude: "40.7128",
        longitude: "-74.006",
        timeZone: "America/New_York",
      });

      const select = screen.getByLabelText("重复民用时间选择（可选）");
      const submit = screen.getByRole("button", { name: "校验时间并生成命盘" });
      expect(submit).toBeDisabled();
      expect(select).toHaveAttribute("aria-invalid", "true");
      expect(select).toHaveAccessibleDescription(/必须选择较早或较晚一次/);

      await user.selectOptions(select, resolution);
      expect(submit).toBeEnabled();
      await user.click(submit);

      expect(push).toHaveBeenCalledWith("/chart");
      expect(pendingInput()).toMatchObject({ civilTimeResolution: resolution });
    },
  );

  it("keeps an invalid IANA zone error on the time-zone field", () => {
    renderIntake();
    fillRequiredFields({ timeZone: "Mars/Olympus" });

    const timeZone = screen.getByLabelText("出生地 IANA 时区");
    fireEvent.blur(timeZone);
    expect(screen.getByRole("button", { name: "校验时间并生成命盘" })).toBeDisabled();
    expect(timeZone).toHaveAttribute("aria-invalid", "true");
    expect(timeZone).toHaveAccessibleDescription(/有效的 IANA 地区时区/);
  });

  it.each(["approximate", "unknown"] as const)(
    "stores the %s time precision in the in-memory session",
    async (timePrecision) => {
      const user = userEvent.setup();
      renderIntake();
      fillRequiredFields();
      await user.click(screen.getByLabelText(timePrecision === "approximate" ? "约略" : "未知"));
      await user.click(screen.getByRole("button", { name: "校验时间并生成命盘" }));

      expect(push).toHaveBeenCalledWith("/chart");
      expect(pendingInput()).toMatchObject({
        localDateTime: "1990-06-15T14:30:45",
        timePrecision,
      });
    },
  );

  it("submits without an optional residence context", async () => {
    const user = userEvent.setup();
    renderIntake();
    fillRequiredFields();
    await user.click(screen.getByRole("button", { name: "校验时间并生成命盘" }));

    expect(push).toHaveBeenCalledWith("/chart");
    expect(pendingInput()).not.toHaveProperty("residenceContext");
  });

  it("submits a complete optional residence context", async () => {
    const user = userEvent.setup();
    renderIntake();
    fillRequiredFields();
    change("生活地名称（可选）", "洛杉矶");
    change("生活地纬度（可选）", "34.0522");
    change("生活地经度（可选）", "-118.2437");
    change("生活地 IANA 时区（可选）", "America/Los_Angeles");
    await user.click(screen.getByRole("button", { name: "校验时间并生成命盘" }));

    expect(push).toHaveBeenCalledWith("/chart");
    expect(pendingInput()).toMatchObject({
      residenceContext: {
        name: "洛杉矶",
        latitude: 34.0522,
        longitude: -118.2437,
        timeZone: "America/Los_Angeles",
      },
    });
  });

  it("stores only in React memory and navigates without birth data in the URL", async () => {
    const user = userEvent.setup();
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const cookieSpy = vi.spyOn(document, "cookie", "set");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderIntake();
    fillRequiredFields();
    await user.click(screen.getByRole("button", { name: "校验时间并生成命盘" }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/chart");
    expect(pendingInput()).toMatchObject({
      localDateTime: "1990-06-15T14:30:45",
      timeZone: "Asia/Shanghai",
    });
    expect(storageSpy).not.toHaveBeenCalled();
    expect(cookieSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("states the memory-only privacy and residence limitations without fortune language", () => {
    const { container } = renderIntake();

    expect(screen.getByText(/资料仅保存在本次页面会话内存中，用于本次计算/)).toBeInTheDocument();
    expect(screen.getByText(/不会写入 localStorage、sessionStorage、Cookie 或数据库/)).toBeInTheDocument();
    expect(screen.getByText(/刷新或关闭页面即清除/)).toBeInTheDocument();
    expect(screen.getByText(/生活地不会改变出生固定命盘/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/吉|凶|身强|身弱|喜用|忌/);
  });
});

describe("Home", () => {
  it("renders the intake page without chart results", () => {
    renderIntake(<Home />);

    expect(screen.getByRole("heading", { level: 1, name: "命盘推演" })).toBeInTheDocument();
    expect(screen.getByText("先校时，再排盘")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "出生资料录入" })).toBeInTheDocument();
    expect(screen.queryByText("命盘结果")).not.toBeInTheDocument();
  });
});
