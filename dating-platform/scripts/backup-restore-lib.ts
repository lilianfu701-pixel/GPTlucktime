export type RestoreCounters = Record<
  "users" | "profiles" | "messages" | "subscriptions" | "entitlements" | "auditEvents" | "foreignKeys",
  number
>;

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
    foreignKeys: "SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f' AND NOT convalidated",
  } satisfies Record<keyof RestoreCounters, string>;
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
    failures.push(`restored database contains ${input.restored.foreignKeys} unvalidated foreign key(s)`);
  }
  if (!input.recentMessageFound) failures.push("recent message was not restored");
  if (!input.subscriptionEntitlementFound) failures.push("subscription/entitlement relation was not restored");
  if (!input.auditEventFound) failures.push("moderation audit event was not restored");
  return failures;
}
