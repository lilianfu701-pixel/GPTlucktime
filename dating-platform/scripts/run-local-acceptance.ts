import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const acceptanceFiles = readdirSync(resolve("tests/e2e"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name));
for (const entry of acceptanceFiles) {
  const path = resolve(entry.parentPath, entry.name);
  if (/\b(?:skip|fixme)\b/iu.test(readFileSync(path, "utf8"))) {
    console.error(`LOCAL_ACCEPTANCE_REJECTED_SKIPPED_TEST:${path}`);
    process.exit(1);
  }
}

const port = process.env.E2E_PORT ?? "3200";
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  E2E_MODE: "1",
  E2E_CONTROL_TOKEN: process.env.E2E_CONTROL_TOKEN ?? "local-acceptance-token-at-least-32-characters",
  E2E_DATABASE_PATH: process.env.E2E_DATABASE_PATH ?? ".artifacts/e2e/member-acceptance-db-socket",
  E2E_DATABASE_PORT: process.env.E2E_DATABASE_PORT ?? "55432",
  E2E_PORT: port,
  APP_URL: process.env.APP_URL ?? `http://127.0.0.1:${port}`,
};

const preflight = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/acceptance-preflight.ts"), "local"], {
  env: environment,
  stdio: "inherit",
});
if (preflight.status !== 0) process.exit(preflight.status ?? 1);

const playwright = spawnSync(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", ...process.argv.slice(2)], {
  env: environment,
  stdio: "inherit",
});
process.exit(playwright.status ?? 1);
