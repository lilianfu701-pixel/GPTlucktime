import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const port = Number(process.env.E2E_PORT ?? 3200);
const databasePort = Number(process.env.E2E_DATABASE_PORT ?? 55432);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const token = process.env.E2E_CONTROL_TOKEN ?? "local-acceptance-token-at-least-32-characters";
const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${databasePort}/postgres?sslmode=disable`;

function localEnvironment() {
  return {
    ...process.env,
    NODE_ENV: "test",
    E2E_MODE: "1",
    E2E_CONTROL_TOKEN: token,
    E2E_DATABASE_PATH: process.env.E2E_DATABASE_PATH ?? ".artifacts/e2e/member-acceptance-db-socket",
    E2E_DATABASE_PORT: String(databasePort),
    E2E_PORT: String(port),
    DATABASE_URL: databaseUrl,
    REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-better-auth-secret-at-least-32-characters",
    BETTER_AUTH_URL: baseURL,
    APP_URL: baseURL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "sk_test_local_adapter_no_live_connection",
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_local_adapter_at_least_32_characters",
  } satisfies NodeJS.ProcessEnv;
}

async function terminateTree(child: ChildProcess | null) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveTermination) => {
      const taskkill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      taskkill.once("error", () => resolveTermination());
      taskkill.once("exit", () => resolveTermination());
    });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
}

async function waitForDatabase(child: ChildProcess) {
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("E2E_DATABASE_START_TIMEOUT")), 60_000);
    child.once("error", rejectReady);
    child.once("exit", (code) => rejectReady(new Error(`E2E_DATABASE_EXIT_${code ?? "UNKNOWN"}`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!chunk.toString("utf8").includes("E2E_DATABASE_READY:")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.stderr?.pipe(process.stderr);
  });
}

async function waitForNext(child: ChildProcess) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`E2E_NEXT_EXIT_${child.exitCode}`);
    try {
      const response = await fetch(new URL("/en/sign-in", baseURL), { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch { /* startup is still in progress */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("E2E_NEXT_START_TIMEOUT");
}

export default async function globalSetup() {
  if (process.env.E2E_BASE_URL) return;
  const env = localEnvironment();
  Object.assign(process.env, env);
  const detached = process.platform !== "win32";
  const database = spawn(process.execPath, ["--import", "tsx", resolve("scripts/start-e2e-server.ts")], {
    env, detached, stdio: ["ignore", "pipe", "pipe"],
  });
  let next: ChildProcess | null = null;
  try {
    await waitForDatabase(database);
    next = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1",
      "--port", String(port)], { env, detached, stdio: "inherit" });
    await waitForNext(next);
  } catch (error) {
    await terminateTree(next);
    await terminateTree(database);
    throw error;
  }
  return async () => {
    await terminateTree(next);
    await terminateTree(database);
  };
}
