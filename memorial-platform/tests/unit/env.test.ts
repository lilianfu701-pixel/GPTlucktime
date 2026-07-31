import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "@/lib/env";

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/memorial_test",
  REDIS_URL: "redis://localhost:6379/1",
  APP_URL: "http://localhost:3000",
  SESSION_SECRET: "12345678901234567890123456789012",
  S3_BUCKET: "memorial-test",
  S3_REGION: "us-west-2",
};

describe("parseEnv", () => {
  it("accepts complete configuration", () => {
    expect(parseEnv(valid).DATABASE_URL).toContain("postgres://");
  });

  it("rejects a short session secret", () => {
    expect(() => parseEnv({ ...valid, SESSION_SECRET: "short" })).toThrow();
  });

  it("rejects a missing database url", () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = valid;
    expect(() => parseEnv(withoutDatabase)).toThrow(EnvValidationError);
  });

  it("rejects a non-postgres database url", () => {
    expect(() =>
      parseEnv({ ...valid, DATABASE_URL: "mysql://user:pass@localhost:3306/db" }),
    ).toThrow(EnvValidationError);
  });

  it("rejects a non-redis cache url", () => {
    expect(() =>
      parseEnv({ ...valid, REDIS_URL: "http://localhost:6379" }),
    ).toThrow(EnvValidationError);
  });

  it("rejects an app url that is not http or https", () => {
    expect(() => parseEnv({ ...valid, APP_URL: "ftp://example.com" })).toThrow(
      EnvValidationError,
    );
  });

  it("names every invalid field so operators can fix configuration", () => {
    expect.assertions(3);
    try {
      parseEnv({ ...valid, SESSION_SECRET: "short", APP_URL: "ftp://bad" });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const fields = (error as EnvValidationError).fields;
      expect(fields).toContain("SESSION_SECRET");
      expect(fields).toContain("APP_URL");
    }
  });

  it("never leaks a rejected secret value in the failure it throws", () => {
    // docs/memorial-platform/06-security-privacy-moderation.md forbids logging
    // credentials, and a validation error is the most likely accidental leak.
    // The secret below is deliberately too short, so SESSION_SECRET is the
    // field that fails: an implementation that echoed the received value would
    // put this string straight into the error.
    const secret = "s3cret-but-far-too-short";
    expect(secret.length).toBeLessThan(32);

    expect.assertions(4);
    try {
      parseEnv({ ...valid, SESSION_SECRET: secret });
    } catch (error) {
      const serialized = `${(error as Error).message}${(error as Error).stack ?? ""}`;
      expect(serialized).not.toContain(secret);
      // The field must still be named, otherwise operators cannot fix it.
      expect(serialized).toContain("SESSION_SECRET");
      expect((error as EnvValidationError).fields).toEqual(["SESSION_SECRET"]);
    }
  });

  it("never leaks a rejected provider credential either", () => {
    const appleKey = "-----BEGIN PRIVATE KEY-----leaked-apple-key";
    expect.assertions(2);
    try {
      parseEnv({ ...valid, APPLE_PRIVATE_KEY: appleKey, SESSION_SECRET: "short" });
    } catch (error) {
      const serialized = `${(error as Error).message}${(error as Error).stack ?? ""}`;
      expect(serialized).not.toContain(appleKey);
      expect(serialized).toContain("SESSION_SECRET");
    }
  });
});

describe("parseEnv optional configuration", () => {
  it("defaults notification providers to the local console adapter", () => {
    const parsed = parseEnv(valid);
    expect(parsed.EMAIL_PROVIDER).toBe("console");
    expect(parsed.SMS_PROVIDER).toBe("console");
  });

  it("leaves the optional storage endpoint undefined when unset", () => {
    expect(parseEnv(valid).S3_ENDPOINT).toBeUndefined();
  });

  it("treats an empty optional string as unset", () => {
    expect(parseEnv({ ...valid, S3_ENDPOINT: "" }).S3_ENDPOINT).toBeUndefined();
    expect(parseEnv({ ...valid, GOOGLE_CLIENT_ID: "" }).GOOGLE_CLIENT_ID).toBeUndefined();
  });
});

describe("parseEnv phone authentication flags", () => {
  it("keeps phone sign-in disabled unless it is explicitly enabled", () => {
    expect(parseEnv(valid).PHONE_AUTH_ENABLED).toBe(false);
    expect(parseEnv({ ...valid, PHONE_AUTH_ENABLED: "false" }).PHONE_AUTH_ENABLED).toBe(
      false,
    );
  });

  it("enables phone sign-in only for a recognized truthy value", () => {
    expect(parseEnv({ ...valid, PHONE_AUTH_ENABLED: "true" }).PHONE_AUTH_ENABLED).toBe(
      true,
    );
  });

  it("rejects an ambiguous phone flag instead of guessing", () => {
    expect(() => parseEnv({ ...valid, PHONE_AUTH_ENABLED: "yes" })).toThrow(
      EnvValidationError,
    );
  });

  it("parses the region allow list into normalized country codes", () => {
    expect(parseEnv({ ...valid, PHONE_AUTH_REGIONS: "us, ca ,MX" }).PHONE_AUTH_REGIONS)
      .toEqual(["US", "CA", "MX"]);
  });

  it("defaults the region allow list to empty so no region is open by accident", () => {
    expect(parseEnv(valid).PHONE_AUTH_REGIONS).toEqual([]);
    expect(parseEnv({ ...valid, PHONE_AUTH_REGIONS: "" }).PHONE_AUTH_REGIONS).toEqual([]);
  });
});
