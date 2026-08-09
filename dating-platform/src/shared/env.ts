import { z } from "zod";

import { parseEncryptionKeyRing, parseLegacyEncryptionKeys } from "@/modules/auth/auth-crypto";
import { parseSocketTicketKeyRing } from "@/modules/messaging/socket-ticket";

const urlWithProtocols = (protocols: readonly string[], message: string) =>
  z
    .string()
    .url()
    .refine((value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, message);

const optionalValue = <T extends z.ZodType>(valueSchema: T) =>
  z.preprocess((value) => value === "" ? undefined : value, valueSchema.optional());

const encryptionKeyRing = z.string().superRefine((value, context) => {
  try {
    parseEncryptionKeyRing(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "AUTH_ENCRYPTION_KEYS is invalid",
    });
  }
});
const legacyEncryptionKey = z.string().superRefine((value, context) => {
  try {
    parseLegacyEncryptionKeys(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "AUTH_LEGACY_ENCRYPTION_KEY is invalid",
    });
  }
});
const realtimeTicketKeyRing = z.string().superRefine((value, context) => {
  try {
    parseSocketTicketKeyRing(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "REALTIME_TICKET_KEYS_INVALID",
    });
  }
});

const commaSeparatedCallingCodes = z.string().regex(/^\d{1,4}(,\d{1,4})*$/);
const commaSeparatedHttpsOrigins = z.string().refine((value) => value.split(",").every((entry) => {
  try {
    const url = new URL(entry);
    return url.protocol === "https:" && url.origin === entry && !url.username && !url.password;
  } catch {
    return false;
  }
}), "must contain comma-separated exact HTTPS origins");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: urlWithProtocols(
      ["postgres:", "postgresql:"],
      "DATABASE_URL must use postgres:// or postgresql://",
    ),
    REDIS_URL: urlWithProtocols(["redis:", "rediss:"], "REDIS_URL must use redis:// or rediss://"),
    BETTER_AUTH_SECRET: z.string().trim().min(32),
    BETTER_AUTH_URL: urlWithProtocols(["http:", "https:"], "BETTER_AUTH_URL must use http:// or https://"),
    APP_URL: urlWithProtocols(["http:", "https:"], "APP_URL must use http:// or https://"),
    AUTH_TRUSTED_PROXY_TOKEN: optionalValue(z.string().min(32)),
    EMAIL_WEBHOOK_URL: optionalValue(urlWithProtocols(["https:"], "EMAIL_WEBHOOK_URL must use https://")),
    EMAIL_WEBHOOK_TOKEN: optionalValue(z.string().min(1)),
    SMS_WEBHOOK_URL: optionalValue(urlWithProtocols(["https:"], "SMS_WEBHOOK_URL must use https://")),
    SMS_WEBHOOK_TOKEN: optionalValue(z.string().min(1)),
    SMS_ABUSE_HMAC_KEY: optionalValue(z.string().min(32)),
    SMS_ALLOWED_CALLING_CODES: optionalValue(commaSeparatedCallingCodes),
    SMS_HIGH_RISK_CALLING_CODES: optionalValue(commaSeparatedCallingCodes),
    SMS_DENIED_PREFIXES: optionalValue(z.string().regex(/^\+\d+(,\+\d+)*$/)),
    IDENTITY_VERIFICATION_PROVIDER: optionalValue(z.string().regex(/^[a-z0-9_-]{1,40}$/)),
    IDENTITY_VERIFICATION_URL: optionalValue(urlWithProtocols(
      ["https:"],
      "IDENTITY_VERIFICATION_URL must use https://",
    )),
    IDENTITY_VERIFICATION_API_KEY: optionalValue(z.string().min(1)),
    IDENTITY_VERIFICATION_WEBHOOK_SECRET: optionalValue(z.string().min(32)),
    IDENTITY_REDIRECT_ORIGINS: optionalValue(commaSeparatedHttpsOrigins),
    AUTH_ENCRYPTION_KEYS: optionalValue(encryptionKeyRing),
    AUTH_LEGACY_ENCRYPTION_KEY: optionalValue(legacyEncryptionKey),
    AUTH_DELIVERY_HMAC_KEY: optionalValue(z.string().min(32)),
    IDENTITY_IDEMPOTENCY_HMAC_KEY: optionalValue(z.string().min(32)),
    PROFILE_MEDIA_STORAGE_ENDPOINT: optionalValue(urlWithProtocols(
      ["http:", "https:"],
      "PROFILE_MEDIA_STORAGE_ENDPOINT must use http:// or https://",
    )),
    PROFILE_MEDIA_STORAGE_REGION: optionalValue(z.string().trim().min(1).max(100)),
    PROFILE_MEDIA_STORAGE_BUCKET: optionalValue(z.string().trim().min(3).max(63)),
    PROFILE_MEDIA_STORAGE_ACCESS_KEY: optionalValue(z.string().min(1)),
    PROFILE_MEDIA_STORAGE_SECRET_KEY: optionalValue(z.string().min(1)),
    PROFILE_MEDIA_TOKEN_SECRET: optionalValue(z.string().min(32)),
    PROFILE_MEDIA_MAX_BYTES: optionalValue(z.coerce.number().int().positive().max(25 * 1024 * 1024)),
    PROFILE_MEDIA_UPLOAD_EXPIRY_SECONDS: optionalValue(z.coerce.number().int().min(30).max(600)),
    PROFILE_MEDIA_MAX_PHOTOS: optionalValue(z.coerce.number().int().min(1).max(12)),
    MEDIA_REVIEW_PROVIDER: optionalValue(z.string().regex(/^[a-z0-9_-]{1,40}$/)),
    MEDIA_REVIEW_URL: optionalValue(urlWithProtocols(["https:"], "MEDIA_REVIEW_URL must use https://")),
    MEDIA_REVIEW_API_KEY: optionalValue(z.string().min(1)),
    MEDIA_REVIEW_VERSION: optionalValue(z.string().trim().min(1).max(40)),
    MEDIA_REVIEW_ALLOWED_ORIGINS: optionalValue(commaSeparatedHttpsOrigins),
    MEDIA_REVIEW_REJECTED_RETENTION_HOURS: optionalValue(z.coerce.number().int().min(1).max(24 * 365)),
    MEDIA_REVIEW_MAX_ATTEMPTS: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.coerce.number().int().min(1).max(20).default(5),
    ),
    MEDIA_WORKER_CRON_SECRET: optionalValue(z.string().min(32).max(256)),
    DISCOVERY_DISABLED_COUNTRY_CODES: optionalValue(z.string().regex(/^[A-Z]{2}(,[A-Z]{2})*$/)),
    REALTIME_TICKET_KEYS: optionalValue(realtimeTicketKeyRing),
  })
  .superRefine((env, context) => {
    const requireCompleteGroup = (
      name: string,
      fields: Array<keyof typeof env>,
      activationFields: Array<keyof typeof env> = fields,
    ) => {
      const active = activationFields.some((field) => env[field] !== undefined);
      const configured = fields.filter((field) => env[field] !== undefined);
      if (active && configured.length !== fields.length) {
        context.addIssue({
          code: "custom",
          message: `${name} configuration must be complete`,
          path: [configured[0] ?? fields[0]],
        });
      }
    };
    requireCompleteGroup("EMAIL", [
      "EMAIL_WEBHOOK_URL",
      "EMAIL_WEBHOOK_TOKEN",
      "AUTH_ENCRYPTION_KEYS",
      "AUTH_DELIVERY_HMAC_KEY",
    ], ["EMAIL_WEBHOOK_URL", "EMAIL_WEBHOOK_TOKEN"]);
    requireCompleteGroup("SMS", [
      "SMS_WEBHOOK_URL",
      "SMS_WEBHOOK_TOKEN",
      "SMS_ABUSE_HMAC_KEY",
      "SMS_ALLOWED_CALLING_CODES",
      "AUTH_ENCRYPTION_KEYS",
      "AUTH_DELIVERY_HMAC_KEY",
      "AUTH_TRUSTED_PROXY_TOKEN",
    ], ["SMS_WEBHOOK_URL", "SMS_WEBHOOK_TOKEN", "SMS_ABUSE_HMAC_KEY", "SMS_ALLOWED_CALLING_CODES"]);
    requireCompleteGroup("IDENTITY", [
      "IDENTITY_VERIFICATION_PROVIDER",
      "IDENTITY_VERIFICATION_URL",
      "IDENTITY_VERIFICATION_API_KEY",
      "IDENTITY_VERIFICATION_WEBHOOK_SECRET",
      "IDENTITY_REDIRECT_ORIGINS",
      "AUTH_ENCRYPTION_KEYS",
      "IDENTITY_IDEMPOTENCY_HMAC_KEY",
    ], [
      "IDENTITY_VERIFICATION_PROVIDER",
      "IDENTITY_VERIFICATION_URL",
      "IDENTITY_VERIFICATION_API_KEY",
      "IDENTITY_VERIFICATION_WEBHOOK_SECRET",
      "IDENTITY_REDIRECT_ORIGINS",
      "IDENTITY_IDEMPOTENCY_HMAC_KEY",
    ]);
    requireCompleteGroup("PROFILE_MEDIA_STORAGE", [
      "PROFILE_MEDIA_STORAGE_ENDPOINT",
      "PROFILE_MEDIA_STORAGE_REGION",
      "PROFILE_MEDIA_STORAGE_BUCKET",
      "PROFILE_MEDIA_STORAGE_ACCESS_KEY",
      "PROFILE_MEDIA_STORAGE_SECRET_KEY",
      "PROFILE_MEDIA_TOKEN_SECRET",
    ], [
      "PROFILE_MEDIA_STORAGE_ENDPOINT",
      "PROFILE_MEDIA_STORAGE_REGION",
      "PROFILE_MEDIA_STORAGE_BUCKET",
      "PROFILE_MEDIA_STORAGE_ACCESS_KEY",
      "PROFILE_MEDIA_STORAGE_SECRET_KEY",
      "PROFILE_MEDIA_TOKEN_SECRET",
    ]);
    requireCompleteGroup("MEDIA_REVIEW", [
      "MEDIA_REVIEW_PROVIDER",
      "MEDIA_REVIEW_URL",
      "MEDIA_REVIEW_API_KEY",
      "MEDIA_REVIEW_VERSION",
      "MEDIA_REVIEW_ALLOWED_ORIGINS",
    ]);
    if (env.SMS_HIGH_RISK_CALLING_CODES) {
      context.addIssue({
        code: "custom",
        message: "SMS high-risk destinations require challenge verification",
        path: ["SMS_HIGH_RISK_CALLING_CODES"],
      });
    }
    if (env.NODE_ENV !== "production") {
      return;
    }

    for (const field of ["BETTER_AUTH_URL", "APP_URL"] as const) {
      if (new URL(env[field]).protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: `${field} must use https:// in production`,
          path: [field],
        });
      }
    }
    if (env.PROFILE_MEDIA_STORAGE_ENDPOINT
      && new URL(env.PROFILE_MEDIA_STORAGE_ENDPOINT).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "PROFILE_MEDIA_STORAGE_ENDPOINT must use https:// in production",
        path: ["PROFILE_MEDIA_STORAGE_ENDPOINT"],
      });
    }
  });

export type AppEnv = z.infer<typeof schema>;
export const readEnv = (input: Partial<NodeJS.ProcessEnv>): AppEnv => schema.parse(input);
