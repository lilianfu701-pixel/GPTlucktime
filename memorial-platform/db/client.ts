import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let database: Database | null = null;

/**
 * The connection pool.
 *
 * Created on first use, like `env()`, so importing a module that touches the
 * database does not open a socket during test collection or a build.
 */
export function getPool(): Pool {
  pool ??= new Pool({
    connectionString: env().DATABASE_URL,
    // A request that cannot get a connection should fail fast and surface as
    // DEPENDENCY_UNAVAILABLE rather than hanging until the client times out.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });
  return pool;
}

export function db(): Database {
  database ??= drizzle(getPool(), { schema });
  return database;
}

/** Releases the pool. Tests call this; long-running processes call it on shutdown. */
export async function closeDb(): Promise<void> {
  const active = pool;
  pool = null;
  database = null;
  if (active) {
    await active.end();
  }
}
