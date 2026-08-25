import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  assertDisposableDatabaseTarget,
  buildDropRestoreDatabasePlan,
  buildForeignKeyMetadataQuery,
  buildForeignKeyOrphanQuery,
  buildRestoreVerificationQueries,
  inspectBackupPreflight,
  verifyRestoreSnapshot,
  type RestoreCounters,
  type ForeignKeyMetadata,
} from "./backup-restore-lib";

const action = process.argv[2];
if (action !== "backup" && action !== "restore") {
  console.error("Usage: tsx scripts/verify-backup-restore.ts <backup|restore>");
  process.exit(2);
}

const findExecutable = (name: string) => {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [name], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] ?? null : null;
};
const failures = inspectBackupPreflight(process.env, findExecutable);
if (failures.length > 0) {
  console.error("PostgreSQL backup/restore preflight failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const sourceUrl = process.env.TEST_DATABASE_URL!;
const restoreUrl = process.env.TEST_RESTORE_DATABASE_URL!;
assertDisposableDatabaseTarget(sourceUrl, "source", restoreUrl);
assertDisposableDatabaseTarget(restoreUrl, "restore", sourceUrl);
const artifact = resolve(process.env.E2E_BACKUP_PATH || ".artifacts/e2e-release.dump");
const metadataPath = `${artifact}.json`;

function connectionEnvironment(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//u, "")),
    ...(parsed.searchParams.get("sslmode") ? { PGSSLMODE: parsed.searchParams.get("sslmode")! } : {}),
  };
}

function run(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(executable, args, { encoding: "utf8", env, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr.trim() || "unknown error"}`);
  return result.stdout.trim();
}

function scalar(databaseUrl: string, query: string) {
  return run("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query],
    connectionEnvironment(databaseUrl));
}

function counters(databaseUrl: string): RestoreCounters {
  const ordinary = Object.fromEntries(Object.entries(buildRestoreVerificationQueries()).map(([key, query]) => [
    key, Number(scalar(databaseUrl, query)),
  ]));
  const metadata = JSON.parse(scalar(databaseUrl, buildForeignKeyMetadataQuery())) as ForeignKeyMetadata[];
  const foreignKeys = metadata.reduce((sum, item) => sum + Number(scalar(databaseUrl, buildForeignKeyOrphanQuery(item))), 0);
  return { ...ordinary, foreignKeys } as RestoreCounters;
}

if (action === "backup") {
  mkdirSync(dirname(artifact), { recursive: true });
  const startedAt = new Date();
  run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", artifact],
    connectionEnvironment(sourceUrl));
  const latestMessageCreatedAt = scalar(sourceUrl, "SELECT coalesce(max(created_at)::text, '') FROM messages");
  const metadata = {
    sourceIdentity: new URL(sourceUrl).pathname,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    latestMessageCreatedAt,
    counts: counters(sourceUrl),
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  console.log(JSON.stringify({ artifact, metadata: metadataPath, bytes: statSync(artifact).size, ...metadata }, null, 2));
  process.exit(0);
}

if (!existsSync(artifact) || !existsSync(metadataPath)) {
  console.error(`Restore verification requires ${artifact} and ${metadataPath}; run npm run db:backup:test first.`);
  process.exit(1);
}
const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
  startedAt: string;
  latestMessageCreatedAt: string;
  counts: RestoreCounters;
};
const restoreStarted = Date.now();
run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error",
  "--dbname", decodeURIComponent(new URL(restoreUrl).pathname.replace(/^\//u, "")), artifact],
connectionEnvironment(restoreUrl));
const restored = counters(restoreUrl);
const recentMessageFound = metadata.latestMessageCreatedAt.length > 0
  && scalar(restoreUrl, `SELECT EXISTS(SELECT 1 FROM messages WHERE created_at = '${metadata.latestMessageCreatedAt.replaceAll("'", "''")}')::text`) === "true";
const subscriptionEntitlementFound = scalar(restoreUrl, `SELECT EXISTS(
  SELECT 1 FROM billing_subscriptions s
  JOIN entitlement_user_plan_assignments e ON e.user_id = s.user_id
)::text`) === "true";
const auditEventFound = scalar(restoreUrl, "SELECT EXISTS(SELECT 1 FROM moderation_audit_events)::text") === "true";
const verificationFailures = verifyRestoreSnapshot({ source: metadata.counts, restored,
  recentMessageFound, subscriptionEntitlementFound, auditEventFound });
if (verificationFailures.length > 0) {
  console.error("Restore verification failed; the disposable restore database and artifacts were retained for investigation:");
  for (const failure of verificationFailures) console.error(`- ${failure}`);
  process.exit(1);
}
const backupStarted = Date.parse(metadata.startedAt);
const latestMessage = Date.parse(metadata.latestMessageCreatedAt);
const report = {
  verified: true,
  rpoSeconds: Number.isFinite(latestMessage) ? Math.max(0, (backupStarted - latestMessage) / 1000) : null,
  rtoSeconds: (Date.now() - restoreStarted) / 1000,
  source: metadata.counts,
  restored,
  artifact,
  note: "The verified disposable restore database and local backup artifacts were removed after success.",
};
const cleanup = buildDropRestoreDatabasePlan(restoreUrl, sourceUrl);
scalar(cleanup.databaseUrl, cleanup.query);
unlinkSync(artifact);
unlinkSync(metadataPath);
console.log(JSON.stringify(report, null, 2));
