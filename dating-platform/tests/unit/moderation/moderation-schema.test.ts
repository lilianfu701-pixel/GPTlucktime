import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  appeals,
  legalWorkflowTasks,
  moderationActions,
  moderationAuditEvents,
  moderationCases,
  moderationContentQuarantines,
  moderationEvidence,
  moderationEvidenceAccess,
  moderationOutboxEvents,
  reports,
  riskSignals,
  safetyAlerts,
  userRestrictions,
} from "@/db/schema";

const config = (table: Parameters<typeof getTableConfig>[0]) => getTableConfig(table);

describe("moderation schema", () => {
  it("defines durable report, case, evidence, safety, appeal and restriction records", () => {
    expect([
      reports,
      moderationCases,
      moderationContentQuarantines,
      moderationActions,
      appeals,
      riskSignals,
      moderationEvidence,
      moderationEvidenceAccess,
      moderationAuditEvents,
      moderationOutboxEvents,
      safetyAlerts,
      legalWorkflowTasks,
      userRestrictions,
    ].map((table) => config(table).name)).toEqual([
      "reports",
      "moderation_cases",
      "moderation_content_quarantines",
      "moderation_actions",
      "appeals",
      "risk_signals",
      "moderation_evidence",
      "moderation_evidence_access",
      "moderation_audit_events",
      "moderation_outbox_events",
      "safety_alerts",
      "legal_workflow_tasks",
      "user_restrictions",
    ]);
  });

  it("enforces database-level report idempotency and duplicate suppression", () => {
    const reportConfig = config(reports);
    const names = [
      ...reportConfig.uniqueConstraints.map((value) => value.name),
      ...reportConfig.indexes.filter((value) => value.config.unique).map((value) => value.config.name),
    ];
    expect(names).toEqual(expect.arrayContaining([
      "reports_reporter_client_unique",
      "reports_active_dedupe_unique",
    ]));
  });

  it("indexes evidence classification and active restrictions for authorization paths", () => {
    const evidenceIndexes = config(moderationEvidence).indexes.map((value) => value.config.name);
    const restrictionIndexes = config(userRestrictions).indexes.map((value) => value.config.name);
    expect(evidenceIndexes).toContain("moderation_evidence_classification_idx");
    expect(restrictionIndexes).toContain("user_restrictions_subject_scope_active_idx");
  });
});
