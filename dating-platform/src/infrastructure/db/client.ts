import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/db/schema";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

export const db = drizzle({ client: pool, schema });
