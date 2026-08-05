import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ??
      "postgresql://dating_platform:local_postgres_password@localhost:5432/dating_platform",
  },
});
