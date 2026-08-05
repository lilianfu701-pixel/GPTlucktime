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
    SMS_WEBHOOK_URL: optionalValue(urlWithProtocols(["https:"], "SMS_WEBHOOK_URL must use https://")),
    SMS_WEBHOOK_TOKEN: optionalValue(z.string().min(1)),
    IDENTITY_VERIFICATION_PROVIDER: optionalValue(z.string().regex(/^[a-z0-9_-]{1,40}$/)),
    IDENTITY_VERIFICATION_URL: optionalValue(urlWithProtocols(
      ["https:"],
      "IDENTITY_VERIFICATION_URL must use https://",
    )),
    IDENTITY_VERIFICATION_API_KEY: optionalValue(z.string().min(1)),
    IDENTITY_VERIFICATION_WEBHOOK_SECRET: optionalValue(z.string().min(32)),
  })
  .superRefine((env, context) => {
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
