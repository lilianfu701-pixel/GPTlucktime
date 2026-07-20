import { StrictMode, useEffect } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateChart } from "../../app/actions/generate-chart";
import { buildChartContext } from "../../core/build-chart-context";
import type { NormalizedBirthInput } from "../../core/types";
import { toChartViewModel } from "../../lib/chart-view-model";
import { ChartSessionProvider, useChartSession } from "../chart-session-provider";
import { ChartRouteClient } from "./chart-route-client";

vi.mock("../../app/actions/generate-chart", () => ({ generateChart: vi.fn() }));

const actionMock = vi.mocked(generateChart);
const input: NormalizedBirthInput = Object.freeze({
  localDateTime: "2024-02-10T12:00:00",
  timeZone: "Etc/UTC",
  birthplace: Object.freeze({ name: "Greenwich", latitude: 0, longitude: 0 }),
  timePrecision: "exact",
});

const secondInput: NormalizedBirthInput = Object.freeze({
  ...input,
  birthplace: Object.freeze({ name: "Second Birthplace", latitude: 0, longitude: 0 }),
});

function viewFor(value: NormalizedBirthInput) {
  const built = buildChartContext(value);
  if (!built.ok) throw new Error(built.message);
  return toChartViewModel(built.value);
}

const viewModel = viewFor(input);
const secondViewModel = viewFor(secondInput);

function SeedInput() {
  const { setBirthInput } = useChartSession();
  useEffect(() => setBirthInput(input), [setBirthInput]);
  return null;
}

function SessionStatus() {
  const { pendingBirthInput } = useChartSession();
  return <output data-testid="session-status">{pendingBirthInput ? "pending" : "cleared"}</output>;
}

function ReplaceInput() {
  const { setBirthInput } = useChartSession();
  return <button type="button" onClick={() => setBirthInput(secondInput)}>use second input</button>;
}

function renderRoute(withInput = true, strict = false, withReplace = false) {
  const route = (
    <ChartSessionProvider>
      {withInput ? <SeedInput /> : null}
      {withReplace ? <ReplaceInput /> : null}
      <ChartRouteClient />
      <SessionStatus />
    </ChartSessionProvider>
  );
  return render(strict ? <StrictMode>{route}</StrictMode> : route);
}

afterEach(cleanup);
beforeEach(() => actionMock.mockReset());

describe("ChartRouteClient", () => {
  it("shows an empty-session recovery link without calling the action", () => {
    renderRoute(false);

    expect(screen.getByRole("heading", { name: "本次会话没有出生资料" })).toBeVisible();
    expect(screen.getByRole("link", { name: "返回出生资料录入" })).toHaveAttribute("href", "/");
    expect(actionMock).not.toHaveBeenCalled();
  });

  it("calls generation once, shows loading, clears input, and retains the view", async () => {
    let resolveAction!: (value: Awaited<ReturnType<typeof generateChart>>) => void;
    actionMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    renderRoute();

    expect(await screen.findByRole("status", { name: "命盘生成状态" })).toHaveTextContent(
      "正在校时并生成静态命盘",
    );
    expect(actionMock).toHaveBeenCalledTimes(1);
    resolveAction({ ok: true, viewModel });

    expect(await screen.findByRole("heading", { name: "四柱命盘" })).toBeVisible();
    expect(screen.getByTestId("session-status")).toHaveTextContent("cleared");
    expect(actionMock).toHaveBeenCalledTimes(1);
  });

  it("keeps input on failure and retries only after an explicit click", async () => {
    const user = userEvent.setup();
    actionMock
      .mockResolvedValueOnce({
        ok: false,
        error: {
          stage: "calculation",
          code: "GENERATION_UNAVAILABLE",
          message: "命盘暂时无法生成，请稍后重试。",
          retryable: true,
        },
      })
      .mockResolvedValueOnce({ ok: true, viewModel });
    renderRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent("命盘暂时无法生成，请稍后重试。");
    expect(screen.getByTestId("session-status")).toHaveTextContent("pending");
    expect(actionMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "重新生成" }));
    expect(await screen.findByRole("heading", { name: "四柱命盘" })).toBeVisible();
    await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("session-status")).toHaveTextContent("cleared");
  });

  it("turns a rejected action request into a retryable safe error", async () => {
    const user = userEvent.setup();
    actionMock
      .mockRejectedValueOnce(new Error("transport-secret"))
      .mockResolvedValueOnce({ ok: true, viewModel });
    renderRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "命盘生成请求失败，请重试。",
    );
    expect(screen.queryByText("transport-secret")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-status")).toHaveTextContent("pending");

    await user.click(screen.getByRole("button", { name: "重新生成" }));
    expect(await screen.findByRole("heading", { name: "四柱命盘" })).toBeVisible();
    expect(actionMock).toHaveBeenCalledTimes(2);
  });

  it("calls the generation action only once for one input under StrictMode", async () => {
    actionMock.mockResolvedValue({ ok: true, viewModel });

    renderRoute(true, true);

    await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "四柱命盘" })).toBeVisible();
  });

  it("ignores an older response after the pending input changes", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: Awaited<ReturnType<typeof generateChart>>) => void;
    let resolveSecond!: (value: Awaited<ReturnType<typeof generateChart>>) => void;
    actionMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    renderRoute(true, false, true);
    await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "use second input" }));
    await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
    resolveSecond({ ok: true, viewModel: secondViewModel });
    expect(await screen.findByText("Second Birthplace")).toBeVisible();

    resolveFirst({ ok: true, viewModel });
    await waitFor(() => expect(screen.getByText("Second Birthplace")).toBeVisible());
    expect(screen.queryByText("Greenwich")).not.toBeInTheDocument();
  });

  it("clears the retained result when restarting birth-data entry", async () => {
    const user = userEvent.setup();
    actionMock.mockResolvedValueOnce({ ok: true, viewModel });
    renderRoute();
    expect(await screen.findByRole("heading", { name: "四柱命盘" })).toBeVisible();

    const restart = screen.getByRole("link", { name: "重新录入出生资料" });
    expect(restart).toHaveAttribute("href", "/");
    await user.click(restart);

    expect(screen.getByRole("heading", { name: "本次会话没有出生资料" })).toBeVisible();
    expect(screen.getByTestId("session-status")).toHaveTextContent("cleared");
  });
});
