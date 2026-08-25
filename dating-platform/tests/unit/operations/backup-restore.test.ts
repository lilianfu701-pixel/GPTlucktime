import { describe, expect, it } from "vitest";

import {
  assertDisposableDatabaseTarget,
  buildDropRestoreDatabasePlan,
  buildForeignKeyMetadataQuery,
  buildForeignKeyOrphanQuery,
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
      "TEST_RESTORE_DATABASE_DISPOSABLE_CONFIRM must exactly match the restore database name",
    ]);
  });

  it.each(["app_e2e", "e2e_app_restore", "app-test", "test-app-restore"])(
    "allows an explicitly delimited disposable name: %s", (database) => {
      expect(() => assertDisposableDatabaseTarget(`postgresql://u:p@127.0.0.1/${database}`, "source"))
        .not.toThrow();
    });

  it.each(["prod", "latest", "contest", "testimony", "e2eproduction", "productione2e"])(
    "refuses a production-like or substring-only name: %s", (database) => {
      expect(() => assertDisposableDatabaseTarget(`postgresql://u:p@127.0.0.1/${database}`, "source"))
        .toThrow("source database name must contain a separated e2e or test token");
    });

  it("refuses identical or non-loopback targets", () => {
    expect(() => assertDisposableDatabaseTarget("postgresql://u:p@db.example/app_e2e", "source"))
      .toThrow("source database host must be loopback");
    expect(() => assertDisposableDatabaseTarget("postgresql://u:p@db/prod", "source"))
      .toThrow("source database host must be loopback");
    expect(() => assertDisposableDatabaseTarget("postgresql://u:p@localhost/app_e2e", "source",
      "postgresql://u:p@localhost/app_e2e")).toThrow("source and restore databases must be different");
    expect(() => assertDisposableDatabaseTarget("postgresql://u:p@localhost/app_e2e", "source",
      "postgresql://u:p@127.0.0.1/app_e2e")).toThrow("source and restore databases must be different");
  });

  it("checks the release-critical restored records and relations", () => {
    const queries = buildRestoreVerificationQueries();
    expect(Object.keys(queries)).toEqual(expect.arrayContaining([
      "users", "profiles", "messages", "subscriptions", "entitlements", "auditEvents",
    ]));
    expect(verifyRestoreSnapshot({
      source: { users: 2, profiles: 2, messages: 1, subscriptions: 1, entitlements: 1, auditEvents: 1, foreignKeys: 0 },
      restored: { users: 2, profiles: 2, messages: 1, subscriptions: 1, entitlements: 1, auditEvents: 1, foreignKeys: 0 },
      recentMessageFound: true,
      subscriptionEntitlementFound: true,
      auditEventFound: true,
    })).toEqual([]);
  });

  it("fails when restored rows violate foreign key relationships", () => {
    const counts = { users: 2, profiles: 2, messages: 1, subscriptions: 1,
      entitlements: 1, auditEvents: 1, foreignKeys: 1 };
    expect(verifyRestoreSnapshot({ source: counts, restored: counts,
      recentMessageFound: true, subscriptionEntitlementFound: true, auditEventFound: true }))
      .toContain("restored database contains 1 foreign key orphan(s)");
  });

  it("discovers every ordinary foreign key and builds a quoted orphan query", () => {
    expect(buildForeignKeyMetadataQuery()).toContain("pg_catalog.pg_constraint");
    expect(buildForeignKeyMetadataQuery()).toContain("con.contype = 'f'");
    const query = buildForeignKeyOrphanQuery({
      childSchema: "public", childTable: "message-receipts",
      parentSchema: "public", parentTable: "users",
      childColumns: ["user_id", "tenant_id"], parentColumns: ["id", "tenant_id"], matchType: "s",
    });
    expect(query).toContain('FROM "public"."message-receipts" child');
    expect(query).toContain('parent."id" = child."user_id"');
    expect(query).toContain('child."user_id" IS NOT NULL');
  });

  it("drops only a separately named disposable restore database through maintenance postgres", () => {
    const plan = buildDropRestoreDatabasePlan(
      "postgresql://u:p@127.0.0.1/app_restore_e2e",
      "postgresql://u:p@127.0.0.1/app_source_e2e",
      "app_restore_e2e",
    );
    expect(plan.databaseUrl).toBe("postgresql://u:p@127.0.0.1/postgres");
    expect(plan.query).toBe('DROP DATABASE "app_restore_e2e" WITH (FORCE)');
    expect(() => buildDropRestoreDatabasePlan(
      "postgresql://u:p@127.0.0.1/app_restore_e2e",
      "postgresql://u:p@127.0.0.1/app_source_e2e",
      "app_source_e2e",
    )).toThrow("disposable confirmation must exactly match restore database name");
    expect(() => buildDropRestoreDatabasePlan(
      "postgresql://u:p@127.0.0.1/latest", "postgresql://u:p@127.0.0.1/app_source_e2e", "latest",
    )).toThrow("restore database name must contain a separated e2e or test token");
  });
});
