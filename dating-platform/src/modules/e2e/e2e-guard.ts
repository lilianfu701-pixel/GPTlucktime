import { timingSafeEqual } from "node:crypto";

type E2eEnvironment = Partial<Record<"NODE_ENV" | "E2E_MODE" | "E2E_CONTROL_TOKEN", string>>;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function authorizeE2eRequest(request: Request, env: E2eEnvironment = process.env) {
  if (env.NODE_ENV !== "test" || env.E2E_MODE !== "1" || !env.E2E_CONTROL_TOKEN) {
    return { authorized: false as const };
  }
  let host: string;
  try { host = new URL(request.url).hostname; } catch { return { authorized: false as const }; }
  if (!loopbackHosts.has(host)) return { authorized: false as const };
  const supplied = request.headers.get("x-e2e-token") ?? "";
  const expected = env.E2E_CONTROL_TOKEN;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length
    || !timingSafeEqual(suppliedBytes, expectedBytes)) return { authorized: false as const };
  return { authorized: true as const };
}

