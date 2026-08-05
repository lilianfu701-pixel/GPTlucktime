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
