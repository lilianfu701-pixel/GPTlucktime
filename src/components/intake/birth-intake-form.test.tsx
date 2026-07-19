import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Home from "../../app/page";
import type { BirthValidationResult } from "../../app/actions/validate-birth-input";
import type { BirthInput } from "../../core/types";
import {
  ChartSessionProvider,
  useChartSession,
} from "../chart-session-provider";
import { BirthIntakeForm } from "./birth-intake-form";

const push = vi.hoisted(() => vi.fn());
const validateBirthInputAction = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));
vi.mock("../../app/actions/validate-birth-input", () => ({
  validateBirthInputAction,
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

function actionResult(input: BirthInput): BirthValidationResult {
  if (input.timeZone === "Mars/Olympus") {
    return {
      valid: false as const,
      code: "INVALID_TIME_ZONE" as const,
      message: "请检查时区后重试",
      retryable: false,
      fieldErrors: { timeZone: "请输入有效的 IANA 地区时区，如 Asia/Shanghai" },
    };
  }
  if (input.localDateTime === "2024-03-10T02:30:00") {
    const message = "该当地时间因夏令时切换而不存在，请调整出生时间";
    return {
      valid: false as const,
      code: "DST_GAP" as const,
      message,
      retryable: false,
      fieldErrors: { birthDate: message, birthTime: message },
    };
  }
  if (
    input.localDateTime === "2024-11-03T01:30:00" &&
    input.civilTimeResolution === undefined
  ) {
    return {
      valid: false as const,
      code: "DST_AMBIGUOUS" as const,
      message: "该当地时间出现两次",
      retryable: false,
      fieldErrors: {
        civilTimeResolution: "该当地时间出现两次，必须选择较早或较晚一次",
      },
    };
  }
  return { valid: true as const, normalized: input };
}

async function expectSubmitEnabled(): Promise<HTMLElement> {
  const submit = screen.getByRole("button", { name: "校验时间并生成命盘" });
  await waitFor(() => expect(submit).toBeEnabled());
  return submit;
}

beforeEach(() => {
  push.mockReset();
  validateBirthInputAction.mockReset();
  validateBirthInputAction.mockImplementation(async (input) =>
    actionResult(input as BirthInput),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BirthIntakeForm", () => {
  it("starts disabled, announces server validation, and enables after authority passes", async () => {
    let resolveValidation: ((value: BirthValidationResult) => void) | undefined;
    validateBirthInputAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveValidation = resolve;
        }),
    );
    renderIntake();
    const submit = screen.getByRole("button", { name: "校验时间并生成命盘" });

    expect(submit).toBeDisabled();
    fillRequiredFields();
    expect(submit).toBeDisabled();
    expect(await screen.findByText(/正在校验/)).toBeInTheDocument();
    await waitFor(() => expect(validateBirthInputAction).toHaveBeenCalledTimes(1));
    const candidate = validateBirthInputAction.mock.calls[0][0] as BirthInput;
    await act(async () => {
      resolveValidation?.(actionResult(candidate));
    });
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it("marks birth fields required and requires residence fields only when that group is used", () => {
    renderIntake();

    for (const label of [
      "出生日期",
      "出生时间（可含秒）",
      "出生地名称",
      "出生地纬度",
      "出生地经度",
      "出生地 IANA 时区",
    ]) {
      expect(screen.getByLabelText(label)).toBeRequired();
    }
    const residenceName = screen.getByLabelText("生活地名称（可选）");
    const residenceLatitude = screen.getByLabelText("生活地纬度（可选）");
    const residenceLongitude = screen.getByLabelText("生活地经度（可选）");
    const residenceTimeZone = screen.getByLabelText("生活地 IANA 时区（可选）");
    expect(residenceName).not.toBeRequired();
    expect(residenceLatitude).not.toBeRequired();
    expect(residenceLongitude).not.toBeRequired();
    expect(residenceTimeZone).not.toBeRequired();

    change("生活地名称（可选）", "洛杉矶");
    expect(residenceName).toBeRequired();
    expect(residenceLatitude).toBeRequired();
    expect(residenceLongitude).toBeRequired();
    expect(residenceTimeZone).toBeRequired();
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

  it("blocks a New York daylight-saving gap and associates the error with date and time", async () => {
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
    await waitFor(() => expect(date).toHaveAttribute("aria-invalid", "true"));
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
      await waitFor(() => expect(select).toHaveAttribute("aria-invalid", "true"));
      expect(select).toHaveAccessibleDescription(/必须选择较早或较晚一次/);

      await user.selectOptions(select, resolution);
      expect(submit).toBeDisabled();
      await waitFor(() => expect(submit).toBeEnabled());
      await user.click(submit);

      expect(push).toHaveBeenCalledWith("/chart");
      expect(pendingInput()).toMatchObject({ civilTimeResolution: resolution });
    },
  );

  it("keeps an invalid IANA zone error on the time-zone field", async () => {
    renderIntake();
    fillRequiredFields({ timeZone: "Mars/Olympus" });

    const timeZone = screen.getByLabelText("出生地 IANA 时区");
    fireEvent.blur(timeZone);
    expect(screen.getByRole("button", { name: "校验时间并生成命盘" })).toBeDisabled();
    await waitFor(() => expect(timeZone).toHaveAttribute("aria-invalid", "true"));
    expect(timeZone).toHaveAccessibleDescription(/有效的 IANA 地区时区/);
  });

  it.each(["approximate", "unknown"] as const)(
    "stores the %s time precision in the in-memory session",
    async (timePrecision) => {
      const user = userEvent.setup();
      renderIntake();
      fillRequiredFields();
      await user.click(screen.getByLabelText(timePrecision === "approximate" ? "约略" : "未知"));
      await user.click(await expectSubmitEnabled());

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
    await user.click(await expectSubmitEnabled());

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
    await user.click(await expectSubmitEnabled());

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
    await user.click(await expectSubmitEnabled());

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

  it("ignores an older authority response after the fields change", async () => {
    type Resolve = (value: BirthValidationResult) => void;
    const resolutions: Resolve[] = [];
    validateBirthInputAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolutions.push(resolve as Resolve);
        }),
    );
    renderIntake();
    fillRequiredFields();
    await waitFor(() => expect(validateBirthInputAction).toHaveBeenCalledTimes(1));

    change("出生时间（可含秒）", "14:31:00");
    await waitFor(() => expect(validateBirthInputAction).toHaveBeenCalledTimes(2));
    const currentInput = validateBirthInputAction.mock.calls[1][0] as BirthInput;
    await act(async () => {
      resolutions[1](actionResult(currentInput));
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "校验时间并生成命盘" }),
      ).toBeEnabled(),
    );

    await act(async () => {
      resolutions[0]({
        valid: false,
        code: "DST_GAP",
        message: "旧响应",
        retryable: false,
        fieldErrors: { birthTime: "旧响应不应显示" },
      });
    });
    expect(screen.queryByText("旧响应不应显示")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "校验时间并生成命盘" }),
    ).toBeEnabled();
  });

  it("shows a retryable generic error when the server action rejects", async () => {
    const user = userEvent.setup();
    validateBirthInputAction.mockRejectedValueOnce(new Error("sensitive detail"));
    renderIntake();
    fillRequiredFields();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "时间校验暂时不可用，请稍后重试",
    );
    expect(screen.queryByText(/sensitive detail/)).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "校验时间并生成命盘" });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "重新校验" }));
    await waitFor(() => expect(validateBirthInputAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it.each([
    ["VALIDATION_UNAVAILABLE", "时间校验暂时不可用，请稍后重试"],
    ["RATE_LIMITED", "校验请求过于频繁，请稍后重试"],
  ] as const)(
    "retries a server %s result only after the user asks",
    async (code, message) => {
      const user = userEvent.setup();
      validateBirthInputAction.mockResolvedValueOnce({
        valid: false,
        code,
        message,
        retryable: true,
        fieldErrors: { form: message },
      });
      renderIntake();
      fillRequiredFields();

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(validateBirthInputAction).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(validateBirthInputAction).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("button", { name: "重新校验" }));
      await waitFor(() => expect(validateBirthInputAction).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "校验时间并生成命盘" }),
        ).toBeEnabled(),
      );
    },
  );

  it.each([
    ["出生地名称", "x".repeat(101), /名称不能超过 100 个字符/],
    ["出生地 IANA 时区", `Area/${"x".repeat(96)}`, /时区不能超过 100 个字符/],
  ] as const)(
    "rejects an overlong %s locally without calling the server action",
    async (label, value, expectedError) => {
      renderIntake();
      fillRequiredFields();
      change(label, value);
      fireEvent.blur(screen.getByLabelText(label));

      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(expectedError);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(validateBirthInputAction).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "校验时间并生成命盘" }),
      ).toBeDisabled();
    },
  );

  it("does not let a pre-retry response overwrite a newer field validation", async () => {
    type Resolve = (value: BirthValidationResult) => void;
    const resolutions: Resolve[] = [];
    validateBirthInputAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolutions.push(resolve as Resolve);
        }),
    );
    renderIntake();
    fillRequiredFields();
    await waitFor(() => expect(validateBirthInputAction).toHaveBeenCalledTimes(1));

    change("出生时间（可含秒）", "14:32:00");
    await waitFor(() => expect(validateBirthInputAction).toHaveBeenCalledTimes(2));
    const currentInput = validateBirthInputAction.mock.calls[1][0] as BirthInput;
    await act(async () => {
      resolutions[1](actionResult(currentInput));
      resolutions[0]({
        valid: false,
        code: "VALIDATION_UNAVAILABLE",
        message: "旧响应",
        retryable: true,
        fieldErrors: { form: "旧响应不应显示" },
      });
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "校验时间并生成命盘" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText("旧响应不应显示")).not.toBeInTheDocument();
  });

  it("states server processing and memory-only privacy without fortune language", () => {
    const { container } = renderIntake();

    expect(screen.getByText(/出生资料会发送到服务器内存执行校验和计算/)).toBeInTheDocument();
    expect(screen.getByText(/不会写入 localStorage、sessionStorage、Cookie 或数据库/)).toBeInTheDocument();
    expect(screen.getByText(/刷新或关闭页面会清除客户端状态/)).toBeInTheDocument();
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
