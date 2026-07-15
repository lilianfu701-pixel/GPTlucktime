import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextCli = resolve(rootDirectory, "node_modules/next/dist/bin/next");
const playwrightCli = resolve(rootDirectory, "node_modules/@playwright/test/cli.js");
const serverUrl = "http://127.0.0.1:3000";
const readinessTimeoutMs = 25_000;
let serverError;

function waitForChild(child, description, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`${description} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
    }

    function onError(error) {
      cleanup();
      rejectExit(error);
    }

    function onClose(code) {
      cleanup();
      resolveExit(code ?? 1);
    }

    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForServer(server) {
  const deadline = Date.now() + readinessTimeoutMs;

  while (Date.now() < deadline) {
    if (serverError) {
      throw serverError;
    }

    if (server.exitCode !== null) {
      throw new Error(`Next server exited before accepting requests (code ${server.exitCode}).`);
    }

    try {
      const response = await fetch(serverUrl, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }

  throw new Error(`Next server did not accept requests within ${readinessTimeoutMs}ms.`);
}

async function stopServer(server) {
  if (server.exitCode !== null || server.pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    // Limit cleanup to the process tree rooted at the server we spawned.
    const taskkill = spawn("taskkill.exe", ["/pid", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    await waitForChild(taskkill, "taskkill", 5_000);
    return;
  }

  server.kill("SIGTERM");
  await waitForChild(server, "Next server", 5_000);
}

const server = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1"], {
  cwd: rootDirectory,
  stdio: "inherit",
  windowsHide: true
});
server.once("error", (error) => {
  serverError = error;
});

let finalizing = false;
async function finalize(exitCode) {
  if (finalizing) {
    return;
  }

  finalizing = true;
  let finalExitCode = exitCode;

  try {
    await stopServer(server);
  } catch (error) {
    console.error("Unable to stop the Next server cleanly:", error);
    finalExitCode = 1;
  } finally {
    process.exitCode = finalExitCode;
    // Windows can retain inherited stdio handles after taskkill. Exit once cleanup was attempted.
    setTimeout(() => process.exit(finalExitCode), 50);
  }
}

process.once("SIGINT", () => void finalize(130));
process.once("SIGTERM", () => void finalize(143));

try {
  await waitForServer(server);
  const tests = spawn(process.execPath, [playwrightCli, "test"], {
    cwd: rootDirectory,
    env: { ...process.env, PLAYWRIGHT_EXTERNAL_SERVER: "1" },
    stdio: "inherit",
    windowsHide: true
  });
  await finalize(await waitForChild(tests, "Playwright", 120_000));
} catch (error) {
  console.error(error);
  await finalize(1);
}
