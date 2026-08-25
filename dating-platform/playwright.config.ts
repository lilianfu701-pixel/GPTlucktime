import { defineConfig, devices } from "@playwright/test";
import { buildLocalE2eEnvironment } from "./scripts/local-acceptance-lib";

const environment = buildLocalE2eEnvironment(process.env);
const baseURL = environment.E2E_BASE_URL!;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium-desktop", testMatch: /.*\.spec\.ts/u, use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-mobile", testMatch: /accessibility\.spec\.ts/u, use: { ...devices["Pixel 7"] } },
  ],
});
