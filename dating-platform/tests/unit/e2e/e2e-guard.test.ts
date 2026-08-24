import { describe, expect, it } from "vitest";

import { authorizeE2eRequest } from "@/modules/e2e/e2e-guard";

const request = (url: string, token = "local-e2e-secret") => new Request(url, {
  headers: { "x-e2e-token": token },
});

describe("E2E control guard", () => {
  it("allows an explicitly enabled test request from localhost", () => {
    expect(authorizeE2eRequest(request("http://127.0.0.1:3000/api/e2e/control"), {
      NODE_ENV: "test",
      E2E_MODE: "1",
      E2E_CONTROL_TOKEN: "local-e2e-secret",
    })).toEqual({ authorized: true });
  });

  it.each([
    ["production environment", { NODE_ENV: "production", E2E_MODE: "1", E2E_CONTROL_TOKEN: "local-e2e-secret" }],
    ["missing explicit mode", { NODE_ENV: "test", E2E_CONTROL_TOKEN: "local-e2e-secret" }],
    ["non-loopback host", { NODE_ENV: "test", E2E_MODE: "1", E2E_CONTROL_TOKEN: "local-e2e-secret" }, "http://example.com/api/e2e/control"],
    ["wrong token", { NODE_ENV: "test", E2E_MODE: "1", E2E_CONTROL_TOKEN: "local-e2e-secret" }, "http://localhost:3000/api/e2e/control", "wrong-token"],
  ])("rejects %s", (_name, env, url = "http://localhost:3000/api/e2e/control", token = "local-e2e-secret") => {
    expect(authorizeE2eRequest(request(url, token), env)).toEqual({ authorized: false });
  });
});
