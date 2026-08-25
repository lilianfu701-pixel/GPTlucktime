import { describe, expect, it } from "vitest";

import { buildExternalAcceptanceCommands } from "../../../scripts/external-acceptance-lib";
import { buildLocalAcceptanceCommands, buildProductionBuildEnvironment } from "../../../scripts/local-acceptance-lib";
import { assertTestModeResource, inspectStripeTestConfig } from "../../../scripts/stripe-test-verifier-lib";

describe("release acceptance runners", () => {
  it("runs recovery and Stripe verification after external preflight", () => {
    expect(buildExternalAcceptanceCommands().map((command) => command.label)).toEqual([
      "external preflight", "PostgreSQL backup", "PostgreSQL restore verification", "Stripe test-mode verification",
    ]);
  });

  it("runs every local quality gate before Playwright without recursion", () => {
    const commands = buildLocalAcceptanceCommands([]);
    expect(commands.map((command) => command.label)).toEqual([
      "local preflight", "skip/fixme scan", "TypeScript", "lint", "production build", "Drizzle schema", "Playwright",
    ]);
    expect(commands.flatMap((command) => command.args)).not.toContain("test:acceptance:local");
  });

  it("makes production build controls inert", () => {
    const env = buildProductionBuildEnvironment({ E2E_MODE: "1", E2E_CONTROL_TOKEN: "secret" });
    expect(env.NODE_ENV).toBe("production");
    expect(env.E2E_MODE).toBeUndefined();
    expect(env.E2E_CONTROL_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toMatch(/^postgresql:/u);
  });

  it("requires Stripe test mode and an HTTPS webhook", () => {
    expect(inspectStripeTestConfig({})).toEqual([
      "STRIPE_SECRET_KEY must be a Stripe test secret key",
      "STRIPE_WEBHOOK_SECRET is required",
      "STRIPE_TEST_PRICE_ID must be a Stripe price id",
      "STRIPE_TEST_WEBHOOK_URL must be an HTTPS acceptance endpoint",
    ]);
    expect(inspectStripeTestConfig({
      STRIPE_SECRET_KEY: "sk_live_forbidden", STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_TEST_PRICE_ID: "price_test", STRIPE_TEST_WEBHOOK_URL: "http://localhost/webhook",
    })).toEqual([
      "STRIPE_SECRET_KEY must be a Stripe test secret key",
      "STRIPE_TEST_WEBHOOK_URL must be an HTTPS acceptance endpoint",
    ]);
    expect(() => assertTestModeResource({ livemode: true }, "price"))
      .toThrow("price was not returned in Stripe test mode");
    expect(() => assertTestModeResource({ livemode: false }, "price")).not.toThrow();
  });
});
