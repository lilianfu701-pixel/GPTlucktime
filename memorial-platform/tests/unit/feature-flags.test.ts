import { describe, expect, it } from "vitest";
import {
  featureFlagsFrom,
  phoneAuthAllowedForRegion,
} from "@/lib/feature-flags";
import { parseEnv } from "@/lib/env";
import type { Env } from "@/lib/env";

const baseInput = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/memorial_test",
  REDIS_URL: "redis://localhost:6379/1",
  APP_URL: "http://localhost:3000",
  SESSION_SECRET: "12345678901234567890123456789012",
  S3_BUCKET: "memorial-test",
  S3_REGION: "us-west-2",
};

const config = (overrides: Record<string, unknown> = {}): Env =>
  parseEnv({ ...baseInput, ...overrides });

describe("featureFlagsFrom", () => {
  it("keeps phone sign-in off by default", () => {
    // Phase one ships phone authentication fully built but hidden.
    expect(featureFlagsFrom(config()).phoneAuthEnabled).toBe(false);
  });

  it("reports phone sign-in on only when the flag is set", () => {
    expect(
      featureFlagsFrom(config({ PHONE_AUTH_ENABLED: "true" })).phoneAuthEnabled,
    ).toBe(true);
  });

  it("enables a social provider only when its credentials are configured", () => {
    // Advertising a sign-in button that cannot complete is worse than hiding it.
    expect(featureFlagsFrom(config()).oauthGoogleEnabled).toBe(false);

    const withGoogle = featureFlagsFrom(
      config({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
    );
    expect(withGoogle.oauthGoogleEnabled).toBe(true);
  });

  it("does not enable a provider from a half-configured credential pair", () => {
    expect(
      featureFlagsFrom(config({ GOOGLE_CLIENT_ID: "id" })).oauthGoogleEnabled,
    ).toBe(false);
    expect(
      featureFlagsFrom(config({ GOOGLE_CLIENT_SECRET: "secret" })).oauthGoogleEnabled,
    ).toBe(false);
  });

  it("enables Apple only when both the client id and the private key exist", () => {
    expect(featureFlagsFrom(config()).oauthAppleEnabled).toBe(false);
    expect(
      featureFlagsFrom(
        config({ APPLE_CLIENT_ID: "id", APPLE_PRIVATE_KEY: "key" }),
      ).oauthAppleEnabled,
    ).toBe(true);
  });

  it("keeps the premium interface and machine translation off for the first release", () => {
    const flags = featureFlagsFrom(config());
    expect(flags.premiumUiEnabled).toBe(false);
    expect(flags.machineTranslationEnabled).toBe(false);
  });

  it("leaves public search on, since a public memorial is searchable by default", () => {
    expect(featureFlagsFrom(config()).publicSearchEnabled).toBe(true);
  });
});

describe("phoneAuthAllowedForRegion", () => {
  it("refuses every region while the global flag is off", () => {
    const flags = featureFlagsFrom(config({ PHONE_AUTH_REGIONS: "US,CA" }));
    expect(phoneAuthAllowedForRegion(flags, "US")).toBe(false);
  });

  it("refuses every region when the allow list is empty", () => {
    // Fail closed: an operator who enables the flag but forgets the list must
    // not accidentally open phone sign-in worldwide.
    const flags = featureFlagsFrom(config({ PHONE_AUTH_ENABLED: "true" }));
    expect(flags.phoneAuthEnabled).toBe(true);
    expect(phoneAuthAllowedForRegion(flags, "US")).toBe(false);
  });

  it("allows only a listed region", () => {
    const flags = featureFlagsFrom(
      config({ PHONE_AUTH_ENABLED: "true", PHONE_AUTH_REGIONS: "US, ca" }),
    );
    expect(phoneAuthAllowedForRegion(flags, "US")).toBe(true);
    expect(phoneAuthAllowedForRegion(flags, "CA")).toBe(true);
    expect(phoneAuthAllowedForRegion(flags, "MX")).toBe(false);
  });

  it("compares region codes case-insensitively", () => {
    const flags = featureFlagsFrom(
      config({ PHONE_AUTH_ENABLED: "true", PHONE_AUTH_REGIONS: "US" }),
    );
    expect(phoneAuthAllowedForRegion(flags, "us")).toBe(true);
  });

  it("refuses an empty or unknown region rather than defaulting to allowed", () => {
    const flags = featureFlagsFrom(
      config({ PHONE_AUTH_ENABLED: "true", PHONE_AUTH_REGIONS: "US" }),
    );
    expect(phoneAuthAllowedForRegion(flags, "")).toBe(false);
  });
});
