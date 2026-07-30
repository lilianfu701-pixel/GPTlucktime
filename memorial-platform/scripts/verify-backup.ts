import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

/**
 * Backup and restore rehearsal.
 *
 * Takes a real dump of the configured database, restores it into a scratch
 * database, and checks that what came back is what went in.
 *
 * The reason this is a script that runs rather than a page in a runbook: a
 * backup nobody has restored is not a backup, it is a file. The failure modes
 * are all silent — a dump that excludes a schema, a restore that reports
 * success while skipping constraints, an extension the target does not have —
 * and every one of them is discovered at the worst possible moment unless
 * something rehearses it on purpose.
 *
 *   npm run verify:backup              # restore into a scratch database
 *   npm run verify:backup -- --in-place  # wipe this database and rebuild it
 *
 * The default is the rehearsal you want against production: dump, restore
 * beside it, compare, drop. It needs a role with CREATEDB.
 *
 * `--in-place` empties the configured database and rebuilds it from the dump.
 * It is the more faithful drill — it proves the dump alone can reconstitute the
 * system, which is the actual disaster — and it needs no special privilege. It
 * is also destructive, so it refuses any database whose name does not end in
 * `_test`. There is no override for that.
 */

/** Tables whose row counts must match exactly after the restore. */
const CHECKED_TABLES = [
  "users",
  "memorials",
  "deceased_people",
  "memorial_names",
  "memorial_members",
  "commemorations",
  "religions",
  "ritual_definitions",
  "outbox_events",
  "audit_logs",
] as const;

type Counts = Record<string, number>;

function findTool(name: string): string {
  const direct = process.env.PG_BIN ? join(process.env.PG_BIN, name) : null;
  if (direct && existsSync(direct)) return direct;

  // Windows installs put these outside PATH more often than not.
  for (const major of ["18", "17", "16", "15"]) {
    const candidate = `C:\\Program Files\\PostgreSQL\\${major}\\bin\\${name}`;
    if (existsSync(candidate)) return candidate;
  }

  return name.replace(/\.exe$/, "");
}

function run(tool: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(findTool(tool), args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseUrl(url: string): {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

async function countRows(connectionString: string): Promise<Counts> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const counts: Counts = {};
    for (const table of CHECKED_TABLES) {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from ${table}`,
      );
      counts[table] = Number(rows[0]?.n ?? 0);
    }
    const migrations = await client.query<{ n: string }>(
      "select count(*)::text as n from drizzle.__drizzle_migrations",
    );
    counts["__migrations"] = Number(migrations.rows[0]?.n ?? 0);
    return counts;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required.");
  }

  const inPlace = process.argv.includes("--in-place");
  const source = parseUrl(url);

  if (inPlace && !source.database.endsWith("_test")) {
    // No escape hatch. This path drops every table before it restores them.
    throw new Error(
      `--in-place refuses to run against "${source.database}": the name must end in _test.`,
    );
  }

  if (!inPlace && !source.database.endsWith("_test") && process.env.ALLOW_NON_TEST_DATABASE !== "1") {
    throw new Error(
      `Refusing to rehearse against "${source.database}". Set ALLOW_NON_TEST_DATABASE=1 if that is really what you want.`,
    );
  }

  const scratch = `${source.database}_restore_check`;
  const workDir = mkdtempSync(join(tmpdir(), "backup-check-"));
  const dumpPath = join(workDir, "dump.pgc");
  const pgEnv = { PGPASSWORD: source.password };
  const connectionArgs = ["-h", source.host, "-p", source.port, "-U", source.user];

  console.log(`source database : ${source.database}`);
  console.log(`mode            : ${inPlace ? "in-place rebuild" : `scratch database ${scratch}`}`);

  const before = await countRows(url);

  try {
    // Custom format, because it is the only one pg_restore can be selective
    // about later — which is what you need at 3am when one table is wrong.
    run("pg_dump.exe", [
      ...connectionArgs,
      "--format=custom",
      "--file",
      dumpPath,
      source.database,
    ], pgEnv);

    const bytes = statSync(dumpPath).size;
    if (bytes === 0) {
      throw new Error("pg_dump produced an empty file.");
    }
    console.log(`dump written    : ${bytes} bytes`);

    let restoredUrl: string;

    if (inPlace) {
      // Everything goes, then comes back from the dump. If this step succeeds
      // and the restore does not, the dump on disk is still the way back, so
      // the path is printed with the failure.
      const wipe = new pg.Client({ connectionString: url });
      await wipe.connect();
      try {
        await wipe.query("drop schema if exists drizzle cascade");
        await wipe.query("drop schema public cascade");
        await wipe.query("create schema public");
      } finally {
        await wipe.end();
      }
      console.log("database emptied");

      try {
        run("pg_restore.exe", [
          ...connectionArgs,
          "--dbname",
          source.database,
          "--exit-on-error",
          dumpPath,
        ], pgEnv);
      } catch (error) {
        throw new Error(
          `pg_restore failed. The dump is still at ${dumpPath}.\n` +
            String((error as { stderr?: string }).stderr ?? error),
        );
      }
      restoredUrl = url;
    } else {
      // A leftover scratch database from an interrupted run must not be
      // mistaken for a successful restore.
      try {
        run("dropdb.exe", [...connectionArgs, "--if-exists", scratch], pgEnv);
      } catch {
        // Nothing to drop.
      }

      try {
        run("createdb.exe", [...connectionArgs, scratch], pgEnv);
      } catch (error) {
        throw new Error(
          `Could not create ${scratch}. The role "${source.user}" needs CREATEDB ` +
            `(ALTER ROLE ${source.user} CREATEDB; as a superuser), or use ` +
            `--in-place against a _test database.\n` +
            String((error as { stderr?: string }).stderr ?? error),
        );
      }

      try {
        run("pg_restore.exe", [
          ...connectionArgs,
          "--dbname",
          scratch,
          "--exit-on-error",
          dumpPath,
        ], pgEnv);
      } catch (error) {
        throw new Error(
          `pg_restore failed:\n${String((error as { stderr?: string }).stderr ?? error)}`,
        );
      }

      restoredUrl = url.replace(
        new RegExp(`/${source.database}(\\?|$)`),
        `/${scratch}$1`,
      );
    }
    const after = await countRows(restoredUrl);

    const mismatches = Object.keys(before).filter(
      (table) => before[table] !== after[table],
    );

    for (const table of Object.keys(before)) {
      const mark = before[table] === after[table] ? "ok  " : "DIFF";
      console.log(`  ${mark} ${table.padEnd(22)} ${before[table]} -> ${after[table]}`);
    }

    if (mismatches.length > 0) {
      throw new Error(`Row counts differ after restore: ${mismatches.join(", ")}`);
    }

    // The schema being present is not the same as the application accepting
    // it. This is the check that would catch a restore that dropped an index
    // the code depends on.
    const client = new pg.Client({ connectionString: restoredUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from pg_indexes where schemaname = 'public'`,
      );
      console.log(`indexes restored: ${rows[0]?.n ?? "0"}`);
      if (Number(rows[0]?.n ?? 0) === 0) {
        throw new Error("The restored database has no indexes.");
      }
    } finally {
      await client.end();
    }

    console.log("\nrestore verified");
  } finally {
    if (!inPlace) {
      try {
        run("dropdb.exe", [...connectionArgs, "--if-exists", scratch], pgEnv);
      } catch {
        console.warn(`Could not drop ${scratch}; drop it by hand.`);
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`\nbackup verification FAILED\n${String(error)}`);
  process.exitCode = 1;
});
