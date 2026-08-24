import { describe, expect, it } from "vitest";

import { inspectAcceptancePreflight } from "../../../scripts/acceptance-preflight-lib";

describe("acceptance preflight", () => {
  it("fails closed with exact local requirements", () => {
    expect(inspectAcceptancePreflight("local", {}, () => null)).toEqual([
      "NODE_ENV must be test for local acceptance",
      "E2E_MODE must be 1 for local acceptance",
      "E2E_CONTROL_TOKEN must contain at least 32 characters",
    ]);
  });

  it("passes deterministic local preflight without external credentials", () => {
    expect(inspectAcceptancePreflight("local", {
      NODE_ENV: "test",
      E2E_MODE: "1",
      E2E_CONTROL_TOKEN: "local-acceptance-token-at-least-32-characters",
    }, () => null)).toEqual([]);
  });

  it("fails closed with every missing external requirement", () => {
    expect(inspectAcceptancePreflight("external", {}, () => null)).toEqual([
      "TEST_DATABASE_URL is required and must name a disposable E2E source database",
      "TEST_RESTORE_DATABASE_URL is required and must name a different disposable E2E restore database",
      "pg_dump executable was not found on PATH",
      "pg_restore executable was not found on PATH",
      "psql executable was not found on PATH",
      "STRIPE_SECRET_KEY is required for the external provider gate",
      "STRIPE_WEBHOOK_SECRET is required for the external provider gate",
      "STRIPE_TEST_PRICE_ID is required for the external provider gate",
      "STRIPE_TEST_WEBHOOK_URL must be an HTTPS acceptance endpoint",
    ]);
  });
});
