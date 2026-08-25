import { describe, expect, it } from "vitest";

import { authorizeE2eRequest, requireE2eDatabaseUrl, requireE2eRuntime } from "@/modules/e2e/e2e-guard";

const secret = "local-e2e-secret-at-least-32-characters";
const request = (url: string, token = secret) => new Request(url, {
  headers: { "x-e2e-token": token },
});

describe("E2E control guard", () => {
  it("allows an explicitly enabled test request from localhost", () => {
    expect(authorizeE2eRequest(request("http://127.0.0.1:3000/api/e2e/control"), {
      NODE_ENV: "test",
      E2E_MODE: "1",
      E2E_CONTROL_TOKEN: secret,
    })).toEqual({ authorized: true });
  });

  it.each([
    ["production environment", { NODE_ENV: "production", E2E_MODE: "1", E2E_CONTROL_TOKEN: secret }],
    ["missing explicit mode", { NODE_ENV: "test", E2E_CONTROL_TOKEN: secret }],
    ["short secret", { NODE_ENV: "test", E2E_MODE: "1", E2E_CONTROL_TOKEN: "local-e2e-secret" }],
    ["non-loopback host", { NODE_ENV: "test", E2E_MODE: "1", E2E_CONTROL_TOKEN: secret }, "http://example.com/api/e2e/control"],
    ["wrong token", { NODE_ENV: "test", E2E_MODE: "1", E2E_CONTROL_TOKEN: secret }, "http://localhost:3000/api/e2e/control", "wrong-token"],
  ])("rejects %s", (_name, env, url = "http://localhost:3000/api/e2e/control", token = secret) => {
    expect(authorizeE2eRequest(request(url, token), env)).toEqual({ authorized: false });
  });

  it("requires a loopback application URL and explicit database path", () => {
    expect(requireE2eRuntime({
      NODE_ENV: "test",
      E2E_MODE: "1",
      E2E_CONTROL_TOKEN: secret,
      APP_URL: "http://127.0.0.1:3200",
      E2E_DATABASE_PATH: ".artifacts/e2e/member-db",
    })).toEqual({ databasePath: ".artifacts/e2e/member-db" });
  });

  it.each([
    ["production", { NODE_ENV: "production", E2E_MODE: "1", E2E_CONTROL_TOKEN: secret, APP_URL: "http://127.0.0.1:3200", E2E_DATABASE_PATH: "db" }],
    ["public URL", { NODE_ENV: "test", E2E_MODE: "1", E2E_CONTROL_TOKEN: secret, APP_URL: "https://example.com", E2E_DATABASE_PATH: "db" }],
    ["missing database", { NODE_ENV: "test", E2E_MODE: "1", E2E_CONTROL_TOKEN: secret, APP_URL: "http://localhost:3200" }],
  ])("fails closed for %s", (_name, env) => {
    expect(() => requireE2eRuntime(env)).toThrow("E2E_RUNTIME_REJECTED");
  });

  it("accepts only a loopback PostgreSQL socket URL with SSL disabled", () => {
    expect(() => requireE2eDatabaseUrl(
      "postgresql://postgres:postgres@127.0.0.1:55432/postgres?sslmode=disable",
    )).not.toThrow();
    expect(() => requireE2eDatabaseUrl("postgresql://example.com/postgres?sslmode=disable"))
      .toThrow("E2E_DATABASE_URL_REJECTED");
    expect(() => requireE2eDatabaseUrl("postgresql://127.0.0.1/postgres"))
      .toThrow("E2E_DATABASE_URL_REJECTED");
  });
});
