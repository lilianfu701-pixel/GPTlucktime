import { describe, expect, it } from "vitest";

import { buildExternalAcceptanceCommands } from "../../../scripts/external-acceptance-lib";
import { buildLocalAcceptanceCommands, buildProductionBuildEnvironment,
  selectLocalAcceptanceEnvironment } from "../../../scripts/local-acceptance-lib";
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
    const env = buildProductionBuildEnvironment({ E2E_MODE: "1", E2E_CONTROL_TOKEN: "secret",
      STRIPE_SECRET_KEY: "must-not-leak", APP_URL: "http://127.0.0.1:3200" });
    expect(env.NODE_ENV).toBe("production");
    expect(env.E2E_MODE).toBeUndefined();
    expect(env.E2E_CONTROL_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toMatch(/^postgresql:/u);
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:6379/15");
    expect(env.BETTER_AUTH_URL).toBe("https://acceptance-build.invalid/api/auth");
    expect(env.APP_URL).toBe("https://acceptance-build.invalid");
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("keeps production placeholders out of the Playwright loopback runtime", () => {
    const e2e = { NODE_ENV: "test", E2E_MODE: "1", APP_URL: "http://127.0.0.1:3200",
      REDIS_URL: "redis://127.0.0.1:6379" } as const satisfies NodeJS.ProcessEnv;
    expect(selectLocalAcceptanceEnvironment("Playwright", e2e, {})).toBe(e2e);
    expect(selectLocalAcceptanceEnvironment("production build", e2e, {}).APP_URL)
      .toBe("https://acceptance-build.invalid");
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
