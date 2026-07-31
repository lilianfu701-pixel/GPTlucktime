import { NextResponse } from "next/server";
import { Pool } from "pg";

export const dynamic = "force-dynamic";

export async function GET() {
  const connStr = process.env.DATABASE_URL ?? "(not set)";
  const masked = connStr.replace(/:([^@]+)@/, ":***@");
  const host = connStr.match(/@([^:/]+)/)?.[1] ?? "unknown";
  const port = connStr.match(/:(\d+)\//)?.[1] ?? "unknown";

  const pool = new Pool({
    connectionString: connStr,
    connectionTimeoutMillis: 8_000,
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const result = await pool.query("SELECT 1 AS ok");
    return NextResponse.json({
      status: "connected",
      masked_url: masked,
      host,
      port,
      result: result.rows[0],
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const pgError = error as Record<string, unknown>;
    return NextResponse.json(
      {
        status: "failed",
        masked_url: masked,
        host,
        port,
        error_message: err.message.replace(/:([^@]+)@/g, ":***@"),
        error_code: pgError.code ?? null,
        error_name: err.name,
      },
      { status: 503 },
    );
  } finally {
    await pool.end();
  }
}
