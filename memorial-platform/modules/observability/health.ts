import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/**
 * Readiness.
 *
 * The two failures below look identical from outside and need opposite
 * responses, which is the whole reason they are reported separately. A database
 * that cannot be reached is an incident. Migrations that have not been applied
 * is a deploy that went out in the wrong order — the process is healthy, it is
 * answering, and it is quietly running against a schema it was not written for.
 * That second one is the dangerous one, because nothing else notices.
 */
export type ReadinessStatus = "ready" | "migrations_pending" | "database_unavailable";

export type Readiness = {
  status: ReadinessStatus;
  /** Migrations the build expects, and how many the database has applied. */
  migrations: { expected: number; applied: number } | null;
};

/** Counts the migrations this build ships, from drizzle's own journal. */
export function expectedMigrationCount(
  journalPath = join(process.cwd(), "drizzle", "meta", "_journal.json"),
): number {
  try {
    const raw = readFileSync(journalPath, "utf8");
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
  } catch {
    // A missing journal is not a reason to report the database unhealthy; it
    // means this process cannot tell, and saying so is better than guessing.
    return 0;
  }
}

export async function checkReadiness(): Promise<Readiness> {
  let applied: number;

  try {
    const result = await db().execute<{ count: string }>(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    applied = Number(result.rows[0]?.count ?? 0);
  } catch (error) {
    const safeMessage =
      error instanceof Error
        ? error.message.replace(/\/\/[^@]+@/, "//***@").replace(/password=[^\s&]+/g, "password=***")
        : "unknown";
    const pgCode = error && typeof error === "object" && "code" in error ? (error as { code: string }).code : "n/a";
    console.error("[health/ready] DB connection failed:", safeMessage, "pgCode:", pgCode);
    return { status: "database_unavailable", migrations: null };
  }

  const expected = expectedMigrationCount();

  // Only "behind" counts. A database ahead of this build is what a rolling
  // deploy looks like halfway through, and refusing traffic then would take
  // the site down during every normal release.
  if (expected > 0 && applied < expected) {
    return { status: "migrations_pending", migrations: { expected, applied } };
  }

  return { status: "ready", migrations: { expected, applied } };
}
