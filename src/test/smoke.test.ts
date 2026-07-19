import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import Home from "../app/page";
import { ChartSessionProvider } from "../components/chart-session-provider";

describe("application shell", () => {
  it("renders the birth-chart intake heading", () => {
    render(createElement(ChartSessionProvider, null, createElement(Home)));

    expect(
      screen.getByRole("heading", { name: "命盘推演" }),
    ).toBeInTheDocument();
  });
});
