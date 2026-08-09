// @vitest-environment node

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runRealtimeMain } from "../../../realtime/main";
import { createRealtimeBackgroundReporter } from "../../../realtime/server";

describe("real-time executable entrypoint", () => {
  it("starts once and gracefully stops on SIGTERM", async () => {
    const signals = new EventEmitter();
    const stop = vi.fn(async () => undefined);
    const started = vi.fn(async () => ({ stop }));
    const running = runRealtimeMain({ start: started, signals });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    signals.emit("SIGTERM");
    await running;
    expect(stop).toHaveBeenCalledOnce();
  });

  it("sets a failed exit code and emits only a stable startup code", async () => {
    const errors: string[] = [];
    const processState = { exitCode: 0 };
    await runRealtimeMain({
      start: async () => { throw new Error("secret database url"); },
      signals: new EventEmitter(),
      processState,
      logError: (code) => errors.push(code),
    });
    expect(processState.exitCode).toBe(1);
    expect(errors).toEqual(["REALTIME_START_FAILED"]);
  });

  it("reports background failures using stable codes without error details", () => {
    const output: string[] = [];
    const report = createRealtimeBackgroundReporter((code) => output.push(code));
    report("REVOCATION_POLL_FAILED");
    report("OUTBOX_CONSUME_FAILED");
    expect(output).toEqual(["REVOCATION_POLL_FAILED", "OUTBOX_CONSUME_FAILED"]);
    expect(output.join(" ")).not.toContain("token");
  });
});
