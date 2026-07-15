import { defineConfig, devices } from "@playwright/test";

const usesManagedServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry"
  },
  webServer: usesManagedServer
    ? undefined
    : {
        command: "node ./node_modules/next/dist/bin/next start --hostname 127.0.0.1",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: false,
        timeout: 120_000
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
