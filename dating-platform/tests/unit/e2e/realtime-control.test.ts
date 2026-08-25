import { describe, expect, it } from "vitest";

import {
  authorizeRealtimeControlRequest,
  enqueueRealtimeLifecycle,
  inspectRealtimeControlConfig,
  parseRealtimeControlAction,
} from "../../../scripts/e2e-realtime-control-lib";

const token = "local-e2e-realtime-control-token-32-characters";
const env = { NODE_ENV: "test", E2E_MODE: "1", E2E_CONTROL_TOKEN: token,
  REALTIME_HOST: "127.0.0.1", REALTIME_CONTROL_HOST: "127.0.0.1" } as const satisfies Partial<NodeJS.ProcessEnv>;

describe("E2E realtime lifecycle guard", () => {
  it("requires explicit test mode, loopback binding, and a strong token", () => {
    expect(inspectRealtimeControlConfig({ NODE_ENV: "production", E2E_MODE: "1",
      E2E_CONTROL_TOKEN: token, REALTIME_HOST: "127.0.0.1", REALTIME_CONTROL_HOST: "127.0.0.1" }))
      .toContain("NODE_ENV must be test");
    expect(inspectRealtimeControlConfig({ ...env, REALTIME_HOST: "0.0.0.0" }))
      .toContain("REALTIME_HOST must be 127.0.0.1");
    expect(inspectRealtimeControlConfig(env)).toEqual([]);
  });

  it("authorizes only loopback callers with the exact token", () => {
    expect(authorizeRealtimeControlRequest(env, "127.0.0.1", token)).toBe(true);
    expect(authorizeRealtimeControlRequest(env, "::ffff:127.0.0.1", token)).toBe(true);
    expect(authorizeRealtimeControlRequest(env, "10.0.0.8", token)).toBe(false);
    expect(authorizeRealtimeControlRequest(env, "127.0.0.1", `${token}x`)).toBe(false);
  });

  it("accepts only explicit POST lifecycle actions", () => {
    expect(parseRealtimeControlAction("POST", "/restart")).toBe("restart");
    expect(parseRealtimeControlAction("POST", "/stop?reason=reconnect")).toBe("stop");
    expect(parseRealtimeControlAction("GET", "/stop")).toBeNull();
    expect(parseRealtimeControlAction("POST", "/reset")).toBeNull();
  });

  it("allows a later lifecycle operation after an earlier operation fails", async () => {
    const first = enqueueRealtimeLifecycle(Promise.resolve(), async () => { throw new Error("stop failed"); });
    await expect(first).rejects.toThrow("stop failed");
    let restarted = false;
    const second = enqueueRealtimeLifecycle(first, async () => { restarted = true; });
    await expect(second).resolves.toBeUndefined();
    expect(restarted).toBe(true);
  });
});
