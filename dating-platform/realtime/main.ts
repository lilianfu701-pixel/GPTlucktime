import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startRealtimeProcess } from "./server";

type SignalSource = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export async function runRealtimeMain(options: {
  start?: () => Promise<{ stop(): Promise<void> }>;
  signals?: SignalSource;
  processState?: { exitCode?: number };
  logError?: (code: "REALTIME_START_FAILED" | "REALTIME_STOP_FAILED") => void;
} = {}) {
  const start = options.start ?? (() => startRealtimeProcess());
  const signals = options.signals ?? process;
  const processState = options.processState ?? process;
  const logError = options.logError ?? ((code: string) => process.stderr.write(`${code}\n`));
  let runtime: { stop(): Promise<void> };
  try { runtime = await start(); } catch {
    processState.exitCode = 1;
    logError("REALTIME_START_FAILED");
    return;
  }
  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      signals.off("SIGINT", stop);
      signals.off("SIGTERM", stop);
      try { await runtime.stop(); } catch {
        processState.exitCode = 1;
        logError("REALTIME_STOP_FAILED");
      }
      resolveStop();
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);
  });
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) void runRealtimeMain();
