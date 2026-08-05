import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  APP_URL: z.string().url(),
});

export type AppEnv = z.infer<typeof schema>;
export const readEnv = (input: NodeJS.ProcessEnv): AppEnv => schema.parse(input);
