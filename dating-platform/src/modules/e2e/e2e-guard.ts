import { timingSafeEqual } from "node:crypto";

type E2eEnvironment = Partial<Record<
  "NODE_ENV" | "E2E_MODE" | "E2E_CONTROL_TOKEN" | "APP_URL" | "E2E_DATABASE_PATH",
  string
>>;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}

function hasStrongToken(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 32;
}

export function requireE2eRuntime(env: E2eEnvironment = process.env) {
  if (env.NODE_ENV !== "test" || env.E2E_MODE !== "1" || !hasStrongToken(env.E2E_CONTROL_TOKEN)
    || !isLoopbackUrl(env.APP_URL) || !env.E2E_DATABASE_PATH?.trim()) {
    throw new Error("E2E_RUNTIME_REJECTED");
  }
  return { databasePath: env.E2E_DATABASE_PATH };
}

export function requireE2eDatabaseUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("E2E_DATABASE_URL_REJECTED"); }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !loopbackHosts.has(url.hostname)
    || url.searchParams.get("sslmode") !== "disable") {
    throw new Error("E2E_DATABASE_URL_REJECTED");
  }
}

export function authorizeE2eRequest(request: Request, env: E2eEnvironment = process.env) {
  if (env.NODE_ENV !== "test" || env.E2E_MODE !== "1" || !hasStrongToken(env.E2E_CONTROL_TOKEN)) {
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
