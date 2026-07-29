import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  // A stray `test.only` must fail the pipeline rather than silently shrink it.
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  // Locally Playwright picks a worker count from the machine; CI pins it to one
  // so shared fixtures stay predictable.
  ...(isCi ? { workers: 1 } : {}),
  reporter: isCi ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    // Locally, reuse whatever is already running; in CI always start clean.
    reuseExistingServer: !isCi,
    timeout: 120_000,
  },
});
