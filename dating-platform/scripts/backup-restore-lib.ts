export type RestoreCounters = Record<
  "users" | "profiles" | "messages" | "subscriptions" | "entitlements" | "auditEvents" | "foreignKeys",
  number
>;

export type ForeignKeyMetadata = {
  childSchema: string;
  childTable: string;
  parentSchema: string;
  parentTable: string;
  childColumns: string[];
  parentColumns: string[];
  matchType: "f" | "p" | "s";
};

type ExecutableLookup = (name: string) => string | null;

export function assertDisposableDatabaseTarget(value: string, label: "source" | "restore", other?: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} database URL is invalid`); }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${label} database URL must use PostgreSQL`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (!/(?:e2e|test)/iu.test(database)) throw new Error(`${label} database name must include e2e or test`);
  if (/^(?:postgres|template0|template1)$/iu.test(database)) throw new Error(`${label} database is protected`);
  if (other && normalizedDatabaseIdentity(value) === normalizedDatabaseIdentity(other)) {
    throw new Error("source and restore databases must be different");
  }
}

function normalizedDatabaseIdentity(value: string) {
  const parsed = new URL(value);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}${parsed.pathname}`;
}

export function inspectBackupPreflight(
  env: Partial<NodeJS.ProcessEnv>,
  lookup: ExecutableLookup,
) {
  const missing: string[] = [];
  if (!env.TEST_DATABASE_URL) missing.push("TEST_DATABASE_URL is required and must name a disposable E2E source database");
  if (!env.TEST_RESTORE_DATABASE_URL) missing.push("TEST_RESTORE_DATABASE_URL is required and must name a different disposable E2E restore database");
  for (const executable of ["pg_dump", "pg_restore", "psql"] as const) {
    if (!lookup(executable)) missing.push(`${executable} executable was not found on PATH`);
  }
  if (env.TEST_DATABASE_URL) {
    try { assertDisposableDatabaseTarget(env.TEST_DATABASE_URL, "source", env.TEST_RESTORE_DATABASE_URL); }
    catch (error) { missing.push(error instanceof Error ? error.message : "source database target is unsafe"); }
  }
  if (env.TEST_RESTORE_DATABASE_URL) {
    try { assertDisposableDatabaseTarget(env.TEST_RESTORE_DATABASE_URL, "restore", env.TEST_DATABASE_URL); }
    catch (error) { missing.push(error instanceof Error ? error.message : "restore database target is unsafe"); }
  }
  return [...new Set(missing)];
}

export function buildRestoreVerificationQueries() {
  return {
    users: "SELECT count(*)::int AS count FROM users",
    profiles: "SELECT count(*)::int AS count FROM profiles",
    messages: "SELECT count(*)::int AS count FROM messages",
    subscriptions: "SELECT count(*)::int AS count FROM billing_subscriptions",
    entitlements: "SELECT count(*)::int AS count FROM entitlement_user_plan_assignments",
    auditEvents: "SELECT count(*)::int AS count FROM moderation_audit_events",
  } satisfies Record<Exclude<keyof RestoreCounters, "foreignKeys">, string>;
}

export function buildForeignKeyMetadataQuery() {
  return `SELECT coalesce(json_agg(json_build_object(
    'childSchema', child_ns.nspname,
    'childTable', child.relname,
    'parentSchema', parent_ns.nspname,
    'parentTable', parent.relname,
    'childColumns', child_cols.columns,
    'parentColumns', parent_cols.columns,
    'matchType', con.confmatchtype
  )), '[]'::json)::text
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
  JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
  JOIN pg_catalog.pg_class parent ON parent.oid = con.confrelid
  JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
  CROSS JOIN LATERAL (
    SELECT array_agg(att.attname ORDER BY key.ordinality) AS columns
    FROM unnest(con.conkey) WITH ORDINALITY key(attnum, ordinality)
    JOIN pg_catalog.pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
  ) child_cols
  CROSS JOIN LATERAL (
    SELECT array_agg(att.attname ORDER BY key.ordinality) AS columns
    FROM unnest(con.confkey) WITH ORDINALITY key(attnum, ordinality)
    JOIN pg_catalog.pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = key.attnum
  ) parent_cols
  WHERE con.contype = 'f'`;
}

function quoteIdentifier(value: string) {
  if (value.includes("\0")) throw new Error("PostgreSQL identifier contains a null byte");
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildForeignKeyOrphanQuery(metadata: ForeignKeyMetadata) {
  if (metadata.childColumns.length === 0 || metadata.childColumns.length !== metadata.parentColumns.length) {
    throw new Error("foreign key metadata columns are invalid");
  }
  const childTable = `${quoteIdentifier(metadata.childSchema)}.${quoteIdentifier(metadata.childTable)}`;
  const parentTable = `${quoteIdentifier(metadata.parentSchema)}.${quoteIdentifier(metadata.parentTable)}`;
  const childNotNull = metadata.childColumns.map((column) => `child.${quoteIdentifier(column)} IS NOT NULL`).join(" AND ");
  const childNull = metadata.childColumns.map((column) => `child.${quoteIdentifier(column)} IS NULL`).join(" AND ");
  const join = metadata.childColumns.map((column, index) =>
    `parent.${quoteIdentifier(metadata.parentColumns[index]!)} = child.${quoteIdentifier(column)}`).join(" AND ");
  const orphan = `(${childNotNull}) AND NOT EXISTS (SELECT 1 FROM ${parentTable} parent WHERE ${join})`;
  const violation = metadata.matchType === "f"
    ? `(NOT (${childNotNull}) AND NOT (${childNull})) OR ${orphan}`
    : orphan;
  return `SELECT count(*)::int AS count FROM ${childTable} child WHERE ${violation}`;
}

export function buildDropRestoreDatabasePlan(restoreUrl: string, sourceUrl: string) {
  assertDisposableDatabaseTarget(restoreUrl, "restore", sourceUrl);
  assertDisposableDatabaseTarget(sourceUrl, "source", restoreUrl);
  const parsed = new URL(restoreUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  const maintenance = new URL(restoreUrl);
  maintenance.pathname = "/postgres";
  return { databaseUrl: maintenance.toString(), query: `DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)` };
}

export function verifyRestoreSnapshot(input: {
  source: RestoreCounters;
  restored: RestoreCounters;
  recentMessageFound: boolean;
  subscriptionEntitlementFound: boolean;
  auditEventFound: boolean;
}) {
  const failures: string[] = [];
  for (const key of Object.keys(input.source) as (keyof RestoreCounters)[]) {
    if (input.source[key] !== input.restored[key]) {
      failures.push(`${key} count differs: source=${input.source[key]} restored=${input.restored[key]}`);
    }
  }
  if (input.restored.foreignKeys !== 0) {
    failures.push(`restored database contains ${input.restored.foreignKeys} foreign key orphan(s)`);
  }
  if (!input.recentMessageFound) failures.push("recent message was not restored");
  if (!input.subscriptionEntitlementFound) failures.push("subscription/entitlement relation was not restored");
  if (!input.auditEventFound) failures.push("moderation audit event was not restored");
  return failures;
}
