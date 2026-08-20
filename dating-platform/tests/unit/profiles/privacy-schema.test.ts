import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { accountDeletionRequests, notificationOutbox, privacyExportJobs, privacyRetentionLedger } from "@/db/schema/privacy";

describe("privacy schema", () => {
  it("exposes durable notification, export, deletion, and restricted retention records", () => {
    expect([notificationOutbox, privacyExportJobs, accountDeletionRequests, privacyRetentionLedger]
      .map((table) => getTableConfig(table).name)).toEqual([
        "notification_outbox", "privacy_export_jobs", "account_deletion_requests", "privacy_retention_ledger",
      ]);
  });

  it("uses database uniqueness for provider-safe replay", () => {
    const uniqueNames = (table: Parameters<typeof getTableConfig>[0]) => getTableConfig(table).uniqueConstraints
      .map((constraint) => constraint.getName());
    expect(uniqueNames(notificationOutbox)).toContain("notification_outbox_dedupe_unique");
    expect(uniqueNames(privacyExportJobs)).toContain("privacy_export_jobs_owner_idempotency_unique");
    expect(uniqueNames(accountDeletionRequests)).toContain("account_deletion_requests_owner_idempotency_unique");
  });

  it("persists and constrains one-time download reservations", () => {
    const columns = getTableConfig(privacyExportJobs).columns.map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["download_lease_id", "download_lease_expires_at"]));
    const checks = getTableConfig(privacyExportJobs).checks.map((check) => check.name);
    expect(checks).toContain("privacy_export_jobs_download_lease_shape_check");
    const migration = readFileSync("drizzle/0040_privacy_workflows.sql", "utf8");
    expect(migration).toContain("PRIVACY_EXPORT_DOWNLOAD_LEASE_STALE");
    expect(migration).toContain("PRIVACY_EXPORT_DOWNLOAD_ALREADY_USED");
  });

  it("registers every restricted moderation and legal workflow family before anonymization", () => {
    const store = readFileSync("src/modules/profiles/privacy-worker-store.ts", "utf8");
    for (const recordType of ["moderation_case", "moderation_evidence", "moderation_quarantine",
      "moderation_media_copy", "moderation_appeal", "moderation_risk_signal", "legal_workflow_task",
      "user_restriction", "media_preservation_task"]) {
      expect(store).toContain(`'${recordType}'`);
    }
  });

  it("serializes deletion requests with session creation and rejects early processing", () => {
    const migration = readFileSync("drizzle/0040_privacy_workflows.sql", "utf8");
    expect(migration).toMatch(/privacy_block_session_during_deletion[\s\S]*PERFORM 1 FROM users WHERE id = NEW\.user_id FOR UPDATE/u);
    expect(migration).toMatch(/OLD\.status = 'cooling_off' AND NEW\.status = 'processing'[\s\S]*statement_timestamp\(\) < OLD\.execute_at/u);
    expect(migration).toMatch(/OLD\.status = 'cooling_off' AND NEW\.status = 'processing'[\s\S]*statement_timestamp\(\) < OLD\.available_at/u);
    expect(migration).toMatch(/NEW\.status <> 'cooling_off'[\s\S]*NEW\.attempts <> 0[\s\S]*NEW\.available_at IS DISTINCT FROM NEW\.execute_at/u);
    expect(migration).toMatch(/NEW\.lease_id IS NOT NULL[\s\S]*NEW\.last_error_code IS NOT NULL[\s\S]*ACCOUNT_DELETION_INVALID_INITIAL_STATE/u);
  });
});
