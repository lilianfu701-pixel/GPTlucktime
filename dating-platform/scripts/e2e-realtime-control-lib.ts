import { timingSafeEqual } from "node:crypto";

type RealtimeAction = "start" | "stop" | "restart";

export function inspectRealtimeControlConfig(env: Partial<NodeJS.ProcessEnv>) {
  const failures: string[] = [];
  if (env.NODE_ENV !== "test") failures.push("NODE_ENV must be test");
  if (env.E2E_MODE !== "1") failures.push("E2E_MODE must be 1");
  if (!env.E2E_CONTROL_TOKEN || env.E2E_CONTROL_TOKEN.length < 32) {
    failures.push("E2E_CONTROL_TOKEN must contain at least 32 characters");
  }
  if (env.REALTIME_HOST !== "127.0.0.1") failures.push("REALTIME_HOST must be 127.0.0.1");
  if (env.REALTIME_CONTROL_HOST !== "127.0.0.1") failures.push("REALTIME_CONTROL_HOST must be 127.0.0.1");
  return failures;
}

export function authorizeRealtimeControlRequest(
  env: Partial<NodeJS.ProcessEnv>,
  remoteAddress: string | undefined,
  candidate: string | undefined,
) {
  if (inspectRealtimeControlConfig(env).length > 0) return false;
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") return false;
  if (!candidate || !env.E2E_CONTROL_TOKEN) return false;
  const expected = Buffer.from(env.E2E_CONTROL_TOKEN);
  const provided = Buffer.from(candidate);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function parseRealtimeControlAction(method: string | undefined, rawUrl: string | undefined): RealtimeAction | null {
  if (method !== "POST" || !rawUrl) return null;
  const pathname = new URL(rawUrl, "http://127.0.0.1").pathname.slice(1);
  return pathname === "start" || pathname === "stop" || pathname === "restart" ? pathname : null;
}
