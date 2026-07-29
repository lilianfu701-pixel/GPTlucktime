import { defineConfig } from "drizzle-kit";

/**
 * Migration tooling reads `DATABASE_URL` straight from the process rather than
 * through `lib/env.ts`: drizzle-kit runs as a CLI outside the application, and
 * pointing it at the wrong database must fail here, loudly, not be papered over
 * by a default.
 */
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required to generate or run migrations. " +
      "Set it in .env.local for development or .env.test for the test database.",
  );
}

export default defineConfig({
  schema: "./db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
