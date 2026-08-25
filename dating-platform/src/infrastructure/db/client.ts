import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/db/schema";
import { requireE2eDatabaseUrl, requireE2eRuntime } from "@/modules/e2e/e2e-guard";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
if (process.env.E2E_MODE === "1") {
  requireE2eRuntime(process.env);
  requireE2eDatabaseUrl(env.DATABASE_URL);
}
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: process.env.E2E_MODE === "1" ? 1 : 10,
  ...(process.env.E2E_MODE === "1" ? { ssl: false } : {}),
});

export const db = drizzle({ client: pool, schema });
