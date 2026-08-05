import { describe, expect, it } from "vitest";

import { readEnv } from "@/shared/env";

const validEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://app:secret@localhost:5432/dating_platform",
  REDIS_URL: "redis://:secret@localhost:6379",
  BETTER_AUTH_SECRET: "a-secure-development-secret-value",
  BETTER_AUTH_URL: "http://localhost:3000/api/auth",
  APP_URL: "http://localhost:3000",
} satisfies NodeJS.ProcessEnv;

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

describe("readEnv", () => {
  it("accepts a valid server environment", () => {
    expect(readEnv(validEnv)).toEqual(validEnv);
  });

  it("accepts a server-only trusted ingress token", () => {
    expect(readEnv({
      ...validEnv,
      AUTH_TRUSTED_PROXY_TOKEN: "trusted-ingress-token-at-least-32-characters",
    }).AUTH_TRUSTED_PROXY_TOKEN).toBe("trusted-ingress-token-at-least-32-characters");
  });

  it("accepts optional HTTPS notification and identity providers", () => {
    expect(readEnv({
      ...validEnv,
      EMAIL_WEBHOOK_URL: "https://notify.example.test/email",
      EMAIL_WEBHOOK_TOKEN: "email-token",
      SMS_WEBHOOK_URL: "https://notify.example.test/sms",
      SMS_WEBHOOK_TOKEN: "sms-token",
      SMS_ABUSE_HMAC_KEY: "sms-abuse-hmac-key-at-least-32-characters",
      SMS_ALLOWED_CALLING_CODES: "1,44",
      AUTH_ENCRYPTION_KEYS: `current:${encryptionKey}`,
      AUTH_DELIVERY_HMAC_KEY: "delivery-hmac-key-at-least-32-characters",
      IDENTITY_VERIFICATION_PROVIDER: "vendor",
      IDENTITY_VERIFICATION_URL: "https://identity.example.test",
      IDENTITY_VERIFICATION_API_KEY: "identity-key",
      IDENTITY_VERIFICATION_WEBHOOK_SECRET: "identity-webhook-secret-value-32",
      IDENTITY_REDIRECT_ORIGINS: "https://identity.example.test,https://identity.example.test:8443",
      IDENTITY_IDEMPOTENCY_HMAC_KEY: "identity-idempotency-hmac-at-least-32-chars",
    })).toMatchObject({ IDENTITY_VERIFICATION_PROVIDER: "vendor" });
  });

  it("rejects duplicate encryption key ids", () => {
    expect(() => readEnv({
      ...validEnv,
      AUTH_ENCRYPTION_KEYS: `duplicate:${encryptionKey},duplicate:${Buffer.alloc(32, 8).toString("base64")}`,
    })).toThrow("AUTH_ENCRYPTION_KEY_ID_DUPLICATE");
  });

  it("rejects high-risk SMS configuration until a challenge verifier is wired", () => {
    expect(() => readEnv({
      ...validEnv,
      SMS_HIGH_RISK_CALLING_CODES: "44",
    })).toThrow("SMS high-risk destinations require challenge verification");
  });

  it.each(["EMAIL_WEBHOOK_URL", "SMS_WEBHOOK_URL", "IDENTITY_VERIFICATION_URL"] as const)(
    "requires HTTPS for optional provider endpoint %s",
    (field) => expect(() => readEnv({ ...validEnv, [field]: "http://provider.test" })).toThrow(field),
  );

  it.each([
    ["email", { EMAIL_WEBHOOK_URL: "https://notify.example.test/email" }],
    ["sms", { SMS_WEBHOOK_URL: "https://notify.example.test/sms" }],
    ["identity", { IDENTITY_VERIFICATION_PROVIDER: "vendor" }],
  ])("rejects a partial %s provider group", (_group, partial) => {
    expect(() => readEnv({ ...validEnv, ...partial })).toThrow("configuration must be complete");
  });

  it("defaults NODE_ENV to development", () => {
    const withoutNodeEnv = Object.fromEntries(
      Object.entries(validEnv).filter(([field]) => field !== "NODE_ENV"),
    );

    expect(readEnv(withoutNodeEnv).NODE_ENV).toBe("development");
  });

  it.each(["DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "APP_URL"] as const)(
    "rejects a missing %s",
    (field) => {
      const incomplete = { ...validEnv };
      delete incomplete[field];

      expect(() => readEnv(incomplete)).toThrow(field);
    },
  );

  it.each([
    ["DATABASE_URL", "https://localhost:5432/dating_platform"],
    ["REDIS_URL", "https://localhost:6379"],
    ["BETTER_AUTH_URL", "ftp://localhost/auth"],
    ["APP_URL", "ftp://localhost"],
  ] as const)("rejects an unsupported protocol for %s", (field, value) => {
    expect(() => readEnv({ ...validEnv, [field]: value })).toThrow(field);
  });

  it.each(["DATABASE_URL", "REDIS_URL", "BETTER_AUTH_URL", "APP_URL"] as const)(
    "rejects a malformed %s",
    (field) => {
      expect(() => readEnv({ ...validEnv, [field]: "not a URL" })).toThrow(field);
    },
  );

  it.each(["short", "                                "])("rejects a weak or blank secret", (secret) => {
    expect(() => readEnv({ ...validEnv, BETTER_AUTH_SECRET: secret })).toThrow("BETTER_AUTH_SECRET");
  });

  it.each(["BETTER_AUTH_URL", "APP_URL"] as const)(
    "requires HTTPS for %s in production",
    (field) => {
      expect(() =>
        readEnv({
          ...validEnv,
          NODE_ENV: "production",
          BETTER_AUTH_URL: "https://example.com/api/auth",
          APP_URL: "https://example.com",
          [field]: "http://example.com",
        }),
      ).toThrow(field);
    },
  );
});
