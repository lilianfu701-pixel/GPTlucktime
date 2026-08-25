import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { buildLocalE2eEnvironment } from "../../scripts/local-acceptance-lib";

const configuredEnvironment = buildLocalE2eEnvironment(process.env);
const port = Number(configuredEnvironment.E2E_PORT);
const baseURL = configuredEnvironment.E2E_BASE_URL!;

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

async function waitForRealtimeControl(child: ChildProcess) {
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("E2E_REALTIME_START_TIMEOUT")), 30_000);
    child.once("error", rejectReady);
    child.once("exit", (code) => rejectReady(new Error(`E2E_REALTIME_EXIT_${code ?? "UNKNOWN"}`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      if (output.includes("E2E_REALTIME_CONTROL_READY:")) {
        clearTimeout(timeout);
        resolveReady();
      } else process.stdout.write(output);
    });
    child.stderr?.pipe(process.stderr);
  });
}

export default async function globalSetup() {
  const env = buildLocalE2eEnvironment(process.env);
  for (const key of Object.keys(process.env)) {
    if (env[key] === undefined) delete process.env[key];
  }
  Object.assign(process.env, env);
  const detached = process.platform !== "win32";
  const database = spawn(process.execPath, ["--import", "tsx", resolve("scripts/start-e2e-server.ts")], {
    env, detached, stdio: ["ignore", "pipe", "pipe"],
  });
  let next: ChildProcess | null = null;
  let realtime: ChildProcess | null = null;
  try {
    await waitForDatabase(database);
    realtime = spawn(process.execPath, ["--import", "tsx", resolve("scripts/start-e2e-realtime.ts")], {
      env, detached, stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForRealtimeControl(realtime);
    next = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1",
      "--port", String(port)], { env, detached, stdio: "inherit" });
    await waitForNext(next);
  } catch (error) {
    await terminateTree(next);
    await terminateTree(realtime);
    await terminateTree(database);
    throw error;
  }
  return async () => {
    await terminateTree(next);
    await terminateTree(realtime);
    await terminateTree(database);
  };
}
