import { describe, expect, it } from "vitest";

import { buildExternalAcceptanceCommands } from "../../../scripts/external-acceptance-lib";
import { buildLocalAcceptanceCommands, buildLocalE2eEnvironment, buildProductionBuildEnvironment,
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

  it("replaces every hostile host endpoint and provider secret in local Playwright", () => {
    const env = buildLocalE2eEnvironment({
      APP_URL: "https://production.example", E2E_BASE_URL: "https://production.example",
      BETTER_AUTH_URL: "https://production.example/api/auth",
      DATABASE_URL: "postgresql://prod:secret@db.example/prod",
      REDIS_URL: "rediss://:secret@redis.example:6380",
      STRIPE_SECRET_KEY: "sk_live_must_not_escape", STRIPE_WEBHOOK_SECRET: "whsec_production",
      EMAIL_WEBHOOK_URL: "https://provider.example/send", EMAIL_WEBHOOK_TOKEN: "production-token",
      REALTIME_PUBLIC_URL: "https://realtime.production.example",
    });
    expect(env.NODE_ENV).toBe("test");
    expect(env.E2E_BASE_URL).toBe("http://127.0.0.1:3200");
    expect(env.APP_URL).toBe("http://127.0.0.1:3200");
    expect(env.BETTER_AUTH_URL).toBe("http://127.0.0.1:3200/api/auth");
    expect(env.DATABASE_URL).toBe("postgresql://postgres:postgres@127.0.0.1:55432/postgres?sslmode=disable");
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:6379/15");
    expect(env.REALTIME_PUBLIC_URL).toBe("http://127.0.0.1:3100");
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_local_adapter_no_live_connection");
    expect(env.STRIPE_WEBHOOK_SECRET).toBe("whsec_local_adapter_at_least_32_characters");
    expect(env.EMAIL_WEBHOOK_URL).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("production");
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
