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
    expect(readEnv(validEnv)).toEqual({ ...validEnv, MEDIA_REVIEW_MAX_ATTEMPTS: 5 });
  });

  it("accepts only configured ISO-shaped disabled discovery countries", () => {
    expect(readEnv({ ...validEnv, DISCOVERY_DISABLED_COUNTRY_CODES: "US,CA" }).DISCOVERY_DISABLED_COUNTRY_CODES)
      .toBe("US,CA");
    expect(() => readEnv({ ...validEnv, DISCOVERY_DISABLED_COUNTRY_CODES: "US,exact-location" }))
      .toThrow("DISCOVERY_DISABLED_COUNTRY_CODES");
  });

  it("accepts an optional valid realtime ticket key ring and rejects malformed rings", () => {
    const ring = `active:${Buffer.alloc(32, 4).toString("base64url")},old:${Buffer.alloc(32, 5).toString("base64url")}`;
    expect(readEnv({ ...validEnv, REALTIME_TICKET_KEYS: ring }).REALTIME_TICKET_KEYS).toBe(ring);
    expect(() => readEnv({ ...validEnv, REALTIME_TICKET_KEYS: "active:short" }))
      .toThrow("REALTIME_TICKET_KEYS_INVALID");
  });

  it("accepts a server-only trusted ingress token", () => {
    expect(readEnv({
      ...validEnv,
      AUTH_TRUSTED_PROXY_TOKEN: "trusted-ingress-token-at-least-32-characters",
    }).AUTH_TRUSTED_PROXY_TOKEN).toBe("trusted-ingress-token-at-least-32-characters");
  });

  it("accepts an explicit legacy ciphertext read key", () => {
    expect(readEnv({
      ...validEnv,
      AUTH_LEGACY_ENCRYPTION_KEY: encryptionKey,
    }).AUTH_LEGACY_ENCRYPTION_KEY).toBe(encryptionKey);
  });

  it("accepts a purpose-mapped legacy ciphertext read key", () => {
    const mapping = `email:${encryptionKey},sms:${Buffer.alloc(32, 8).toString("base64")},identity:${Buffer.alloc(32, 9).toString("base64")}`;
    expect(readEnv({
      ...validEnv,
      AUTH_LEGACY_ENCRYPTION_KEY: mapping,
    }).AUTH_LEGACY_ENCRYPTION_KEY).toBe(mapping);
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
      AUTH_TRUSTED_PROXY_TOKEN: "trusted-ingress-token-at-least-32-characters",
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

  it("accepts only a complete server-side profile media storage group", () => {
    const media = readEnv({
      ...validEnv,
      PROFILE_MEDIA_STORAGE_ENDPOINT: "https://storage.example.test",
      PROFILE_MEDIA_STORAGE_REGION: "us-west-2",
      PROFILE_MEDIA_STORAGE_BUCKET: "profile-media",
      PROFILE_MEDIA_STORAGE_ACCESS_KEY: "storage-access",
      PROFILE_MEDIA_STORAGE_SECRET_KEY: "storage-secret",
      PROFILE_MEDIA_TOKEN_SECRET: "profile-media-token-secret-at-least-32-characters",
    });
    expect(media.PROFILE_MEDIA_STORAGE_BUCKET).toBe("profile-media");
    expect(() => readEnv({
      ...validEnv,
      PROFILE_MEDIA_STORAGE_ENDPOINT: "https://storage.example.test",
    })).toThrow("PROFILE_MEDIA_STORAGE configuration must be complete");
  });

  it("accepts a server-only Vercel Blob profile media backend with its upload-token secret", () => {
    const blob = readEnv({
      ...validEnv,
      BLOB_READ_WRITE_TOKEN: "  blob-read-write-token-at-least-32-characters  ",
      PROFILE_MEDIA_TOKEN_SECRET: "profile-media-token-secret-at-least-32-characters",
    });
    expect(blob.BLOB_READ_WRITE_TOKEN).toBe("blob-read-write-token-at-least-32-characters");
    expect(() => readEnv({
      ...validEnv,
      BLOB_READ_WRITE_TOKEN: "blob-read-write-token-at-least-32-characters",
    })).toThrow("Blob profile media configuration requires PROFILE_MEDIA_TOKEN_SECRET");
    expect(() => readEnv({
      ...validEnv,
      BLOB_READ_WRITE_TOKEN: "                                        ",
      PROFILE_MEDIA_TOKEN_SECRET: "profile-media-token-secret-at-least-32-characters",
    })).toThrow("BLOB_READ_WRITE_TOKEN");
  });

  it("rejects configuring Vercel Blob and S3 profile media together", () => {
    expect(() => readEnv({
      ...validEnv,
      BLOB_READ_WRITE_TOKEN: "blob-read-write-token-at-least-32-characters",
      PROFILE_MEDIA_STORAGE_ENDPOINT: "https://storage.example.test",
      PROFILE_MEDIA_STORAGE_REGION: "us-west-2",
      PROFILE_MEDIA_STORAGE_BUCKET: "profile-media",
      PROFILE_MEDIA_STORAGE_ACCESS_KEY: "storage-access",
      PROFILE_MEDIA_STORAGE_SECRET_KEY: "storage-secret",
      PROFILE_MEDIA_TOKEN_SECRET: "profile-media-token-secret-at-least-32-characters",
    })).toThrow("PROFILE_MEDIA_STORAGE must configure exactly one backend");
  });

  it("does not recognize a public-prefixed Blob credential as server configuration", () => {
    const parsed = readEnv({
      ...validEnv,
      NEXT_PUBLIC_BLOB_READ_WRITE_TOKEN: "public-blob-token-that-must-never-be-used",
    });
    expect(parsed).not.toHaveProperty("NEXT_PUBLIC_BLOB_READ_WRITE_TOKEN");
    expect(parsed).not.toHaveProperty("BLOB_READ_WRITE_TOKEN");
  });

  it("accepts only a complete dedicated admin export storage group", () => {
    const exports = readEnv({
      ...validEnv,
      ADMIN_EXPORT_S3_ENDPOINT: "https://admin-exports.example.test",
      ADMIN_EXPORT_S3_REGION: "us-west-2",
      ADMIN_EXPORT_S3_BUCKET: "private-admin-exports",
      ADMIN_EXPORT_S3_ACCESS_KEY: "admin-export-access",
      ADMIN_EXPORT_S3_SECRET_KEY: "admin-export-secret",
    });
    expect(exports.ADMIN_EXPORT_S3_BUCKET).toBe("private-admin-exports");
    expect(() => readEnv({ ...validEnv,
      ADMIN_EXPORT_S3_ENDPOINT: "https://admin-exports.example.test" }))
      .toThrow("ADMIN_EXPORT_S3 configuration must be complete");
  });

  it("accepts only a complete allowlisted media review provider group", () => {
    const mediaReview = readEnv({
      ...validEnv,
      MEDIA_REVIEW_PROVIDER: "moderator",
      MEDIA_REVIEW_URL: "https://review.example.test/v1/check",
      MEDIA_REVIEW_API_KEY: "review-key",
      MEDIA_REVIEW_VERSION: "v1",
      MEDIA_REVIEW_ALLOWED_ORIGINS: "https://review.example.test",
    });
    expect(mediaReview.MEDIA_REVIEW_PROVIDER).toBe("moderator");
    expect(() => readEnv({
      ...validEnv,
      MEDIA_REVIEW_URL: "https://review.example.test/v1/check",
    })).toThrow("MEDIA_REVIEW configuration must be complete");
    expect(() => readEnv({
      ...validEnv,
      MEDIA_REVIEW_PROVIDER: "moderator",
      MEDIA_REVIEW_URL: "https://review.example.test/v1/check",
      MEDIA_REVIEW_API_KEY: "review-key",
      MEDIA_REVIEW_VERSION: "v1",
      MEDIA_REVIEW_ALLOWED_ORIGINS: "http://review.example.test",
    })).toThrow("exact HTTPS origins");
  });

  it("accepts only a strong internal media worker secret", () => {
    expect(readEnv({
      ...validEnv,
      MEDIA_WORKER_CRON_SECRET: "media-worker-secret-that-is-at-least-32-characters",
    }).MEDIA_WORKER_CRON_SECRET).toBe("media-worker-secret-that-is-at-least-32-characters");
    expect(() => readEnv({ ...validEnv, MEDIA_WORKER_CRON_SECRET: "too-short" }))
      .toThrow("MEDIA_WORKER_CRON_SECRET");
  });

  it("accepts only a complete server-side Stripe group and strong billing worker secret", () => {
    const billing = readEnv({ ...validEnv,
      STRIPE_SECRET_KEY: "sk_test_placeholder_value",
      STRIPE_WEBHOOK_SECRET: "whsec_placeholder_value_at_least_32",
      BILLING_WORKER_CRON_SECRET: "billing-worker-secret-at-least-32-characters",
    });
    expect(billing.STRIPE_SECRET_KEY).toBe("sk_test_placeholder_value");
    expect(() => readEnv({ ...validEnv, STRIPE_SECRET_KEY: "sk_test_only" }))
      .toThrow("STRIPE configuration must be complete");
    expect(() => readEnv({ ...validEnv, BILLING_WORKER_CRON_SECRET: "short" }))
      .toThrow("BILLING_WORKER_CRON_SECRET");
  });

  it("defaults and bounds media review retry attempts", () => {
    expect(readEnv(validEnv).MEDIA_REVIEW_MAX_ATTEMPTS).toBe(5);
    expect(readEnv({ ...validEnv, MEDIA_REVIEW_MAX_ATTEMPTS: "1" }).MEDIA_REVIEW_MAX_ATTEMPTS).toBe(1);
    expect(readEnv({ ...validEnv, MEDIA_REVIEW_MAX_ATTEMPTS: "20" }).MEDIA_REVIEW_MAX_ATTEMPTS).toBe(20);
    expect(() => readEnv({ ...validEnv, MEDIA_REVIEW_MAX_ATTEMPTS: "0" }))
      .toThrow("MEDIA_REVIEW_MAX_ATTEMPTS");
    expect(() => readEnv({ ...validEnv, MEDIA_REVIEW_MAX_ATTEMPTS: "21" }))
      .toThrow("MEDIA_REVIEW_MAX_ATTEMPTS");
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

  it("rejects a complete SMS provider without trusted ingress", () => {
    expect(() => readEnv({
      ...validEnv,
      SMS_WEBHOOK_URL: "https://notify.example.test/sms",
      SMS_WEBHOOK_TOKEN: "sms-token",
      SMS_ABUSE_HMAC_KEY: "sms-abuse-hmac-key-at-least-32-characters",
      SMS_ALLOWED_CALLING_CODES: "1,44",
      AUTH_ENCRYPTION_KEYS: `current:${encryptionKey}`,
      AUTH_DELIVERY_HMAC_KEY: "delivery-hmac-key-at-least-32-characters",
    })).toThrow("SMS configuration must be complete");
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
