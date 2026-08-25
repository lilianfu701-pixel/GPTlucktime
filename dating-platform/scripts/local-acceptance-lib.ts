import { resolve } from "node:path";

import type { AcceptanceCommand } from "./external-acceptance-lib";

export function buildProductionBuildEnvironment(env: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {
    ...env,
    NODE_ENV: "production",
    DATABASE_URL: env.DATABASE_URL ?? "postgresql://acceptance:acceptance@127.0.0.1:5432/acceptance_build",
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET ?? "inert-production-build-secret-32-characters",
    BETTER_AUTH_URL: env.BETTER_AUTH_URL ?? "http://127.0.0.1:3200/api/auth",
    APP_URL: env.APP_URL ?? "http://127.0.0.1:3200",
  };
  delete output.E2E_MODE;
  delete output.E2E_CONTROL_TOKEN;
  delete output.E2E_DATABASE_PATH;
  delete output.E2E_DATABASE_PORT;
  return output;
}

export function buildLocalAcceptanceCommands(playwrightArgs: string[]): AcceptanceCommand[] {
  return [
    { label: "local preflight", executable: process.execPath, args: ["--import", "tsx", resolve("scripts/acceptance-preflight.ts"), "local"] },
    { label: "skip/fixme scan", executable: process.execPath, args: ["--import", "tsx", resolve("scripts/scan-e2e-skips.ts")] },
    { label: "TypeScript", executable: process.execPath, args: [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--incremental", "false"] },
    { label: "lint", executable: process.execPath, args: [resolve("node_modules/eslint/bin/eslint.js"), "."] },
    { label: "production build", executable: process.execPath, args: [resolve("node_modules/next/dist/bin/next"), "build"] },
    { label: "Drizzle schema", executable: process.execPath, args: [resolve("node_modules/drizzle-kit/bin.cjs"), "check"] },
    { label: "Playwright", executable: process.execPath, args: [resolve("node_modules/@playwright/test/cli.js"), "test", ...playwrightArgs] },
  ];
}
