import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedBirthInput } from "../core/types";
import { ChartSessionProvider, useChartSession } from "./chart-session-provider";

const input: NormalizedBirthInput = Object.freeze({
  localDateTime: "1990-06-15T14:30:00",
  timeZone: "Asia/Shanghai",
  birthplace: Object.freeze({ name: "上海", latitude: 31.2304, longitude: 121.4737 }),
  timePrecision: "exact",
});

function SessionHarness() {
  const { pendingBirthInput, setBirthInput, clearBirthInput } = useChartSession();
  return (
    <>
      <output>{pendingBirthInput?.birthplace.name ?? "empty"}</output>
      <button type="button" onClick={() => setBirthInput(input)}>
        set
      </button>
      <button type="button" onClick={clearBirthInput}>
        clear
      </button>
    </>
  );
}

afterEach(cleanup);

describe("ChartSessionProvider", () => {
  it("provides type-safe pending input, set, and clear operations", async () => {
    const user = userEvent.setup();
    render(
      <ChartSessionProvider>
        <SessionHarness />
      </ChartSessionProvider>,
    );

    expect(screen.getByText("empty")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "set" }));
    expect(screen.getByText("上海")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "clear" }));
    expect(screen.getByText("empty")).toBeInTheDocument();
  });

  it("starts empty again when a new provider session mounts", async () => {
    const user = userEvent.setup();
    const first = render(
      <ChartSessionProvider>
        <SessionHarness />
      </ChartSessionProvider>,
    );
    await user.click(screen.getByRole("button", { name: "set" }));
    expect(screen.getByText("上海")).toBeInTheDocument();

    first.unmount();
    render(
      <ChartSessionProvider>
        <SessionHarness />
      </ChartSessionProvider>,
    );
    expect(screen.getByText("empty")).toBeInTheDocument();
  });
});
