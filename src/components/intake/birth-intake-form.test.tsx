import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Home from "../../app/page";
import { decodeChartPayload } from "../../lib/chart-payload";
import { BirthIntakeForm } from "./birth-intake-form";

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillRequiredFields(): void {
  change("出生日期", "1990-06-15");
  change("出生时间（可含秒）", "14:30:45");
  change("出生地名称", "上海");
  change("出生地纬度", "31.2304");
  change("出生地经度", "121.4737");
  change("出生地 IANA 时区", "Asia/Shanghai");
}

function submittedPayload(): string {
  expect(push).toHaveBeenCalledTimes(1);
  const destination = push.mock.calls[0][0] as string;
  expect(destination).toMatch(/^\/chart\?data=[A-Za-z0-9_-]+$/);
  return destination.slice("/chart?data=".length);
}

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BirthIntakeForm", () => {
  it("starts disabled and enables only after all required fields validate", () => {
    render(<BirthIntakeForm />);
    const submit = screen.getByRole("button", { name: "校验时间并生成命盘" });

    expect(submit).toBeDisabled();
    fillRequiredFields();
    expect(submit).toBeEnabled();
  });

  it("associates required and coordinate errors with their fields", async () => {
    const user = userEvent.setup();
    render(<BirthIntakeForm />);
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

  it.each(["approximate", "unknown"] as const)(
    "submits the %s time precision in a decodable payload",
    async (timePrecision) => {
      const user = userEvent.setup();
      render(<BirthIntakeForm />);
      fillRequiredFields();
      await user.click(screen.getByLabelText(timePrecision === "approximate" ? "约略" : "未知"));
      await user.click(screen.getByRole("button", { name: "校验时间并生成命盘" }));

      expect(decodeChartPayload(submittedPayload())).toMatchObject({
        localDateTime: "1990-06-15T14:30:45",
        timePrecision,
      });
    },
  );

  it("submits without an optional residence context", async () => {
    const user = userEvent.setup();
    render(<BirthIntakeForm />);
    fillRequiredFields();
    await user.click(screen.getByRole("button", { name: "校验时间并生成命盘" }));

    expect(decodeChartPayload(submittedPayload())).not.toHaveProperty("residenceContext");
  });

  it("submits a complete optional residence context", async () => {
    const user = userEvent.setup();
    render(<BirthIntakeForm />);
    fillRequiredFields();
    change("生活地名称（可选）", "洛杉矶");
    change("生活地纬度（可选）", "34.0522");
    change("生活地经度（可选）", "-118.2437");
    change("生活地 IANA 时区（可选）", "America/Los_Angeles");
    await user.click(screen.getByRole("button", { name: "校验时间并生成命盘" }));

    expect(decodeChartPayload(submittedPayload())).toMatchObject({
      residenceContext: {
        name: "洛杉矶",
        latitude: 34.0522,
        longitude: -118.2437,
        timeZone: "America/Los_Angeles",
      },
    });
  });

  it("does not call browser persistence or network APIs on submit", async () => {
    const user = userEvent.setup();
    const localStorageSpy = vi.spyOn(Storage.prototype, "setItem");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<BirthIntakeForm />);
    fillRequiredFields();
    await user.click(screen.getByRole("button", { name: "校验时间并生成命盘" }));

    expect(localStorageSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    submittedPayload();
  });

  it("shows privacy and residence limitations without fortune language", () => {
    const { container } = render(<BirthIntakeForm />);

    expect(screen.getByText(/精确出生资料只用于本次计算/)).toBeInTheDocument();
    expect(screen.getByText(/不会写入 localStorage、sessionStorage、Cookie 或数据库/)).toBeInTheDocument();
    expect(screen.getByText(/生活地不会改变出生固定命盘/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/吉|凶|身强|身弱|喜用|忌/);
  });
});

describe("Home", () => {
  it("renders the intake page without chart results", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { level: 1, name: "命盘推演" })).toBeInTheDocument();
    expect(screen.getByText("先校时，再排盘")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "出生资料录入" })).toBeInTheDocument();
    expect(screen.queryByText("命盘结果")).not.toBeInTheDocument();
  });
});
