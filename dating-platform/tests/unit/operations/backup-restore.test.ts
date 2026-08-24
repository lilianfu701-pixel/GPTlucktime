import { describe, expect, it } from "vitest";

import {
  assertDisposableDatabaseTarget,
  buildRestoreVerificationQueries,
  inspectBackupPreflight,
  verifyRestoreSnapshot,
} from "../../../scripts/backup-restore-lib";

describe("backup restore guard", () => {
  it("reports exact missing external requirements", () => {
    expect(inspectBackupPreflight({}, () => null)).toEqual([
      "TEST_DATABASE_URL is required and must name a disposable E2E source database",
      "TEST_RESTORE_DATABASE_URL is required and must name a different disposable E2E restore database",
      "pg_dump executable was not found on PATH",
      "pg_restore executable was not found on PATH",
      "psql executable was not found on PATH",
    ]);
  });

  it("refuses production-like, shared, or identical database targets", () => {
    expect(() => assertDisposableDatabaseTarget("postgresql://u:p@db/prod", "source"))
      .toThrow("source database name must include e2e or test");
    expect(() => assertDisposableDatabaseTarget("postgresql://u:p@db/app_e2e", "source",
      "postgresql://u:p@db/app_e2e")).toThrow("source and restore databases must be different");
  });

  it("checks the release-critical restored records and relations", () => {
    const queries = buildRestoreVerificationQueries();
    expect(Object.keys(queries)).toEqual(expect.arrayContaining([
      "users", "profiles", "messages", "subscriptions", "entitlements", "auditEvents", "foreignKeys",
    ]));
    expect(verifyRestoreSnapshot({
      source: { users: 2, profiles: 2, messages: 1, subscriptions: 1, entitlements: 1, auditEvents: 1, foreignKeys: 0 },
      restored: { users: 2, profiles: 2, messages: 1, subscriptions: 1, entitlements: 1, auditEvents: 1, foreignKeys: 0 },
      recentMessageFound: true,
      subscriptionEntitlementFound: true,
      auditEventFound: true,
    })).toEqual([]);
  });

  it("fails when the restored schema contains unvalidated foreign keys", () => {
    const counts = { users: 2, profiles: 2, messages: 1, subscriptions: 1,
      entitlements: 1, auditEvents: 1, foreignKeys: 1 };
    expect(verifyRestoreSnapshot({ source: counts, restored: counts,
      recentMessageFound: true, subscriptionEntitlementFound: true, auditEventFound: true }))
      .toContain("restored database contains 1 unvalidated foreign key(s)");
  });
});
