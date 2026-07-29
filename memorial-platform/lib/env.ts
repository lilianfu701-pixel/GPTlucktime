import { z } from "zod";

/**
 * Configuration validation.
 *
 * Every message in this file is a static string authored here. Nothing derived
 * from a configured value reaches the error, so a misconfigured
 * `SESSION_SECRET` or provider key cannot be echoed into a log or a crash
 * report. See docs/memorial-platform/06-security-privacy-moderation.md
 * section 8 and 09-deployment-operations.md section 2.
 */
export class EnvValidationError extends Error {
  readonly fields: string[];

  constructor(fields: string[], details: string[]) {
    super(`Invalid environment configuration:\n${details.join("\n")}`);
    this.name = "EnvValidationError";
    this.fields = fields;
  }
}

/** Treats an unset variable and an empty one the same way. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalSecret = z.preprocess(
  blankToUndefined,
  z.string().optional(),
);

const optionalUrl = z.preprocess(
  blankToUndefined,
  z.url({ error: "must be a valid URL" }).optional(),
);

const httpUrl = z
  .url({ error: "must be a valid URL" })
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    { error: "must use http or https" },
  );

const postgresUrl = z
  .string({ error: "is required" })
  .refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    { error: "must be a postgres:// or postgresql:// connection string" },
  );

const redisUrl = z
  .string({ error: "is required" })
  .refine(
    (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
    { error: "must be a redis:// or rediss:// connection string" },
  );

/**
 * Only unambiguous values flip a feature flag. A typo such as `yes` fails
 * loudly instead of silently leaving phone sign-in in an unintended state.
 */
const booleanFlag = z
  .enum(["true", "false", "1", "0"], {
    error: 'must be exactly "true" or "false"',
  })
  .default("false")
  .transform((value) => value === "true" || value === "1");

/** Comma separated ISO 3166-1 alpha-2 codes; empty means no region is open. */
const regionList = z
  .string({ error: "must be a comma separated list of country codes" })
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry.length > 0),
  );

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"], {
      error: "must be development, test or production",
    })
    .default("development"),

  APP_URL: httpUrl,
  SESSION_SECRET: z
    .string({ error: "is required" })
    .min(32, { error: "must be at least 32 characters" }),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  S3_BUCKET: z.string({ error: "is required" }).min(1, { error: "is required" }),
  S3_REGION: z.string({ error: "is required" }).min(1, { error: "is required" }),
  S3_ENDPOINT: optionalUrl,

  EMAIL_PROVIDER: z.string().default("console"),
  SMS_PROVIDER: z.string().default("console"),

  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,
  APPLE_CLIENT_ID: optionalSecret,
  APPLE_PRIVATE_KEY: optionalSecret,

  PHONE_AUTH_ENABLED: booleanFlag,
  PHONE_AUTH_REGIONS: regionList,
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(input: Record<string, unknown>): Env {
  const result = envSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  const fields: string[] = [];
  const details: string[] = [];

  for (const issue of result.error.issues) {
    const field = issue.path.join(".") || "(root)";
    if (!fields.includes(field)) {
      fields.push(field);
    }
    details.push(`  ${field} ${issue.message}`);
  }

  throw new EnvValidationError(fields, details);
}

let cached: Env | null = null;

/**
 * Reads and validates configuration on first use.
 *
 * Evaluated lazily on purpose: importing a module that touches configuration
 * must not crash test collection or a build that never reaches runtime.
 */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test seam. Clears the memoized configuration. */
export function resetEnvCache(): void {
  cached = null;
}
