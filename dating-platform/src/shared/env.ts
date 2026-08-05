import { z } from "zod";

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

const encryptionKey = z.string().refine((value) => {
  try {
    return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be a base64-encoded 32-byte key");

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
    EMAIL_WEBHOOK_URL: optionalValue(urlWithProtocols(["https:"], "EMAIL_WEBHOOK_URL must use https://")),
    EMAIL_WEBHOOK_TOKEN: optionalValue(z.string().min(1)),
    EMAIL_PAYLOAD_ENCRYPTION_KEY: optionalValue(encryptionKey),
    SMS_WEBHOOK_URL: optionalValue(urlWithProtocols(["https:"], "SMS_WEBHOOK_URL must use https://")),
    SMS_WEBHOOK_TOKEN: optionalValue(z.string().min(1)),
    SMS_PAYLOAD_ENCRYPTION_KEY: optionalValue(encryptionKey),
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
    IDENTITY_PAYLOAD_ENCRYPTION_KEY: optionalValue(encryptionKey),
  })
  .superRefine((env, context) => {
    const requireCompleteGroup = (
      name: string,
      fields: Array<keyof typeof env>,
    ) => {
      const configured = fields.filter((field) => env[field] !== undefined);
      if (configured.length > 0 && configured.length !== fields.length) {
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
      "EMAIL_PAYLOAD_ENCRYPTION_KEY",
    ]);
    requireCompleteGroup("SMS", [
      "SMS_WEBHOOK_URL",
      "SMS_WEBHOOK_TOKEN",
      "SMS_PAYLOAD_ENCRYPTION_KEY",
      "SMS_ABUSE_HMAC_KEY",
      "SMS_ALLOWED_CALLING_CODES",
    ]);
    requireCompleteGroup("IDENTITY", [
      "IDENTITY_VERIFICATION_PROVIDER",
      "IDENTITY_VERIFICATION_URL",
      "IDENTITY_VERIFICATION_API_KEY",
      "IDENTITY_VERIFICATION_WEBHOOK_SECRET",
      "IDENTITY_REDIRECT_ORIGINS",
      "IDENTITY_PAYLOAD_ENCRYPTION_KEY",
    ]);
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
  });

export type AppEnv = z.infer<typeof schema>;
export const readEnv = (input: Partial<NodeJS.ProcessEnv>): AppEnv => schema.parse(input);
