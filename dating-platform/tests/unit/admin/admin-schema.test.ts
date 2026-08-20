import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  adminActionIdempotency,
  adminApprovalDecisions,
  adminApprovalRequests,
  adminAuditLogs,
  adminConfigChanges,
  adminOutboxEvents,
  adminRoleAssignments,
  adminSessions,
  adminBulkActionItems,
  adminExportJobs,
  adminRefundIntents,
  adminSafetyAccessGrants,
  adminUserActionVersions,
} from "@/db/schema";

describe("admin schema", () => {
  it("exports isolated sessions, RBAC, approval, audit, configuration and idempotency records", () => {
    expect([
      adminRoleAssignments, adminSessions, adminApprovalRequests, adminApprovalDecisions,
      adminAuditLogs, adminConfigChanges, adminActionIdempotency, adminOutboxEvents,
    ].map((table) => getTableConfig(table).name)).toEqual([
      "admin_role_assignments", "admin_sessions", "admin_approval_requests", "admin_approval_decisions",
      "admin_audit_logs", "admin_config_changes", "admin_action_idempotency", "admin_outbox_events",
    ]);
  });

  it("has durable action-specific execution facts and session-bound approvals", () => {
    expect([
      adminBulkActionItems, adminExportJobs, adminRefundIntents, adminSafetyAccessGrants, adminUserActionVersions,
    ].map((table) => getTableConfig(table).name)).toEqual([
      "admin_bulk_action_items", "admin_export_jobs", "admin_refund_intents", "admin_safety_access_grants",
      "admin_user_action_versions",
    ]);
    expect(adminApprovalRequests.requesterAdminSessionId).toBeDefined();
    expect(adminApprovalDecisions.approverAdminSessionId).toBeDefined();
    expect(adminApprovalRequests.leaseId).toBeDefined();
    expect(adminApprovalRequests.availableAt).toBeDefined();
    expect(adminApprovalRequests.attempts).toBeDefined();
  });

  it("has unique server-side session, approval execution, and idempotency boundaries", () => {
    const uniqueNames = (table: Parameters<typeof getTableConfig>[0]) => {
      const config = getTableConfig(table);
      return [...config.uniqueConstraints.map((item) => item.name),
        ...config.indexes.filter((item) => item.config.unique).map((item) => item.config.name)];
    };
    expect(uniqueNames(adminSessions)).toContain("admin_sessions_token_hash_unique");
    expect(uniqueNames(adminApprovalDecisions)).toContain("admin_approval_decisions_request_unique");
    expect(uniqueNames(adminActionIdempotency)).toContain("admin_action_idempotency_actor_key_unique");
  });
});
