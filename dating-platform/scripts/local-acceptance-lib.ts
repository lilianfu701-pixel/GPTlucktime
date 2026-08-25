import { resolve } from "node:path";

import type { AcceptanceCommand } from "./external-acceptance-lib";

const SYSTEM_ENVIRONMENT_KEYS = [
  "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "windir", "COMSPEC", "ComSpec",
  "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "USERNAME", "USERDOMAIN", "OS",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "TERM", "COLORTERM", "LANG", "LC_ALL", "TZ",
  "CI", "NO_COLOR", "FORCE_COLOR", "PLAYWRIGHT_BROWSERS_PATH",
] as const;

function systemEnvironment(env: Partial<NodeJS.ProcessEnv>) {
  return Object.fromEntries(SYSTEM_ENVIRONMENT_KEYS.flatMap((key) =>
    env[key] === undefined ? [] : [[key, env[key]]]));
}

export function buildProductionBuildEnvironment(env: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {
    ...systemEnvironment(env),
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://acceptance:acceptance@127.0.0.1:5432/acceptance_build",
    REDIS_URL: "redis://127.0.0.1:6379/15",
    BETTER_AUTH_SECRET: "inert-production-build-secret-32-characters",
    BETTER_AUTH_URL: "https://acceptance-build.invalid/api/auth",
    APP_URL: "https://acceptance-build.invalid",
  };
  delete output.E2E_MODE;
  delete output.E2E_CONTROL_TOKEN;
  delete output.E2E_DATABASE_PATH;
  delete output.E2E_DATABASE_PORT;
  return output;
}

export function buildLocalE2eEnvironment(env: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const appUrl = "http://127.0.0.1:3200";
  return {
    ...systemEnvironment(env),
    NODE_ENV: "test",
    E2E_MODE: "1",
    E2E_CONTROL_TOKEN: "local-acceptance-token-at-least-32-characters",
    E2E_PORT: "3200",
    E2E_BASE_URL: appUrl,
    APP_URL: appUrl,
    BETTER_AUTH_URL: `${appUrl}/api/auth`,
    BETTER_AUTH_SECRET: "e2e-better-auth-secret-at-least-32-characters",
    E2E_DATABASE_PATH: ".artifacts/e2e/member-acceptance-db-socket",
    E2E_DATABASE_PORT: "55432",
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/postgres?sslmode=disable",
    REDIS_URL: "redis://127.0.0.1:6379/15",
    STRIPE_SECRET_KEY: "sk_test_local_adapter_no_live_connection",
    STRIPE_WEBHOOK_SECRET: "whsec_local_adapter_at_least_32_characters",
    REALTIME_TICKET_KEYS: `e2e:${Buffer.alloc(32, 7).toString("base64url")}`,
    REALTIME_HOST: "127.0.0.1",
    REALTIME_PORT: "3100",
    REALTIME_POLL_MS: "5000",
    REALTIME_PUBLIC_URL: "http://127.0.0.1:3100",
    REALTIME_CONTROL_HOST: "127.0.0.1",
    E2E_REALTIME_CONTROL_PORT: "3101",
  };
}

export function selectLocalAcceptanceEnvironment(
  label: string,
  e2eEnvironment: NodeJS.ProcessEnv,
  hostEnvironment: Partial<NodeJS.ProcessEnv>,
) {
  return label === "production build" ? buildProductionBuildEnvironment(hostEnvironment) : e2eEnvironment;
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
