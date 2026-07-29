import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

describe("application scaffold", () => {
  it("pins the supported runtime and scripts", () => {
    expect(packageJson.engines.node).toBe(">=22.13.0");
    expect(packageJson.scripts).toMatchObject({
      test: "vitest run",
      "test:e2e": "playwright test",
      build: "next build",
      lint: "eslint .",
      typecheck: "tsc --noEmit",
    });
  });
});
