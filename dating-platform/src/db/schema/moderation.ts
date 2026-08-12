import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { conversations, messages } from "./messaging";
import { profilePhotos, profiles } from "./profiles";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export type ModerationTargetSnapshot = {
  schemaVersion: 1;
  targetType: "profile" | "message";
  targetUserId: string;
  targetProfileId: string;
  capturedAt: string;
  displayName: string | null;
  messageId: string | null;
  conversationId: string | null;
};

export type ControlledEvidenceLocator = {
  schemaVersion: 1;
  referenceType: "profile" | "message" | "photo";
  referenceId: string;
  conversationId?: string;
};

export const reports = pgTable("reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  reporterUserId: uuid("reporter_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  targetProfileId: uuid("target_profile_id").notNull().references(() => profiles.id, { onDelete: "restrict" }),
  targetType: text("target_type").notNull(),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "restrict" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "restrict" }),
  reasonCode: varchar("reason_code", { length: 40 }).notNull(),
  locale: varchar("locale", { length: 35 }).notNull(),
  explanation: text("explanation").notNull(),
  clientId: uuid("client_id").notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 64 }).notNull(),
  targetSnapshot: jsonb("target_snapshot").$type<ModerationTargetSnapshot>().notNull(),
  publicStatus: text("public_status").default("submitted").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("reports_reporter_client_unique").on(table.reporterUserId, table.clientId),
  uniqueIndex("reports_active_dedupe_unique").on(table.dedupeKey)
    .where(sql`${table.publicStatus} IN ('submitted', 'in_review')`),
  index("reports_owner_created_idx").on(table.reporterUserId, table.createdAt, table.id),
  index("reports_target_created_idx").on(table.targetUserId, table.createdAt),
  check("reports_not_self_check", sql`${table.reporterUserId} <> ${table.targetUserId}`),
  check("reports_target_type_check", sql`${table.targetType} IN ('profile', 'message')`),
  check("reports_reason_check", sql`${table.reasonCode} IN ('HARASSMENT', 'HATE_OR_ABUSE', 'IMPERSONATION', 'MINOR_SAFETY', 'SCAM_OR_FRAUD', 'SEXUAL_CONTENT', 'SPAM', 'THREATS_OR_VIOLENCE', 'OTHER_SAFETY')`),
  check("reports_locale_length_check", sql`char_length(${table.locale}) BETWEEN 2 AND 35`),
  check("reports_explanation_length_check", sql`char_length(${table.explanation}) BETWEEN 1 AND 1000`),
  check("reports_hash_length_check", sql`char_length(${table.requestHash}) = 64 AND char_length(${table.dedupeKey}) = 64`),
  check("reports_public_status_check", sql`${table.publicStatus} IN ('submitted', 'in_review', 'resolved')`),
  check("reports_message_reference_check", sql`
    (${table.targetType} = 'profile' AND ${table.messageId} IS NULL AND ${table.conversationId} IS NULL)
    OR (${table.targetType} = 'message' AND ${table.messageId} IS NOT NULL AND ${table.conversationId} IS NOT NULL)
  `),
]);

export const moderationCases = pgTable("moderation_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "restrict" }),
  kind: text("kind").default("initial").notNull(),
  originalCaseId: uuid("original_case_id"),
  status: text("status").default("submitted").notNull(),
  priority: text("priority").default("normal").notNull(),
  assignedWorkerUserId: uuid("assigned_worker_user_id").references(() => users.id, { onDelete: "restrict" }),
  finalDecisionSummary: text("final_decision_summary"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  finalizedAt: timestamptz("finalized_at"),
}, (table) => [
  uniqueIndex("moderation_cases_initial_report_unique").on(table.reportId)
    .where(sql`${table.kind} = 'initial'`),
  uniqueIndex("moderation_cases_appeal_original_unique").on(table.originalCaseId)
    .where(sql`${table.kind} = 'appeal'`),
  foreignKey({
    columns: [table.originalCaseId],
    foreignColumns: [table.id],
    name: "moderation_cases_original_case_fk",
  }).onDelete("restrict"),
  index("moderation_cases_queue_idx").on(table.status, table.priority, table.createdAt),
  check("moderation_cases_kind_check", sql`${table.kind} IN ('initial', 'appeal')`),
  check("moderation_cases_status_check", sql`${table.status} IN ('submitted', 'triaged', 'under_review', 'actioned', 'dismissed')`),
  check("moderation_cases_priority_check", sql`${table.priority} IN ('normal', 'high', 'emergency')`),
  check("moderation_cases_origin_check", sql`
    (${table.kind} = 'initial' AND ${table.originalCaseId} IS NULL)
    OR (${table.kind} = 'appeal' AND ${table.originalCaseId} IS NOT NULL)
  `),
  check("moderation_cases_final_check", sql`
    (${table.status} IN ('actioned', 'dismissed') AND ${table.finalizedAt} IS NOT NULL AND ${table.finalDecisionSummary} IS NOT NULL)
    OR (${table.status} NOT IN ('actioned', 'dismissed') AND ${table.finalizedAt} IS NULL)
  `),
]);

export const moderationActions = pgTable("moderation_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  subjectUserId: uuid("subject_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  actionType: text("action_type").notNull(),
  reasonCode: varchar("reason_code", { length: 80 }).notNull(),
  evidenceSummary: text("evidence_summary").notNull(),
  operatorUserId: uuid("operator_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  expiryPolicy: text("expiry_policy").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  index("moderation_actions_case_created_idx").on(table.caseId, table.createdAt),
  index("moderation_actions_subject_created_idx").on(table.subjectUserId, table.createdAt),
  check("moderation_actions_type_check", sql`${table.actionType} IN ('warn', 'temporary_restriction', 'suspend', 'ban', 'quarantine_content', 'restore')`),
  check("moderation_actions_expiry_policy_check", sql`${table.expiryPolicy} IN ('fixed', 'indefinite_review')`),
  check("moderation_actions_window_check", sql`${table.expiresAt} > ${table.createdAt}`),
  check("moderation_actions_reason_length_check", sql`char_length(${table.reasonCode}) BETWEEN 1 AND 80`),
  check("moderation_actions_evidence_length_check", sql`char_length(${table.evidenceSummary}) BETWEEN 1 AND 2000`),
]);

export const appeals = pgTable("appeals", {
  id: uuid("id").defaultRandom().primaryKey(),
  appellantUserId: uuid("appellant_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  originalCaseId: uuid("original_case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  reviewCaseId: uuid("review_case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  statement: text("statement").notNull(),
  status: text("status").default("submitted").notNull(),
  finalDecisionSummary: text("final_decision_summary"),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  finalizedAt: timestamptz("finalized_at"),
}, (table) => [
  unique("appeals_original_case_unique").on(table.originalCaseId),
  unique("appeals_review_case_unique").on(table.reviewCaseId),
  index("appeals_appellant_created_idx").on(table.appellantUserId, table.createdAt),
  check("appeals_status_check", sql`${table.status} IN ('submitted', 'under_review', 'upheld', 'overturned', 'modified')`),
  check("appeals_statement_length_check", sql`char_length(${table.statement}) BETWEEN 1 AND 2000`),
  check("appeals_distinct_cases_check", sql`${table.originalCaseId} <> ${table.reviewCaseId}`),
  check("appeals_final_check", sql`
    (${table.status} IN ('upheld', 'overturned', 'modified') AND ${table.finalDecisionSummary} IS NOT NULL AND ${table.decidedByUserId} IS NOT NULL AND ${table.finalizedAt} IS NOT NULL)
    OR (${table.status} NOT IN ('upheld', 'overturned', 'modified') AND ${table.finalizedAt} IS NULL)
  `),
]);

export const riskSignals = pgTable("risk_signals", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "restrict" }),
  subjectUserId: uuid("subject_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  signalType: varchar("signal_type", { length: 80 }).notNull(),
  confidenceBasisPoints: integer("confidence_basis_points").notNull(),
  source: text("source").default("report_triage").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("risk_signals_report_type_unique").on(table.reportId, table.signalType),
  index("risk_signals_subject_created_idx").on(table.subjectUserId, table.createdAt),
  check("risk_signals_confidence_check", sql`${table.confidenceBasisPoints} BETWEEN 0 AND 10000`),
  check("risk_signals_source_check", sql`${table.source} IN ('report_triage', 'case_worker', 'trusted_provider')`),
]);

export const moderationEvidence = pgTable("moderation_evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "restrict" }),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  classification: text("classification").default("ordinary").notNull(),
  locator: jsonb("locator").$type<ControlledEvidenceLocator>().notNull(),
  integritySha256: varchar("integrity_sha256", { length: 64 }).notNull(),
  preserveUntil: timestamptz("preserve_until").notNull(),
  quarantinedAt: timestamptz("quarantined_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("moderation_evidence_report_kind_hash_unique").on(table.reportId, table.kind, table.integritySha256),
  index("moderation_evidence_case_idx").on(table.caseId, table.createdAt),
  index("moderation_evidence_classification_idx").on(table.classification, table.preserveUntil),
  check("moderation_evidence_kind_check", sql`${table.kind} IN ('target_snapshot', 'message_reference', 'profile_reference', 'photo_reference')`),
  check("moderation_evidence_classification_check", sql`${table.classification} IN ('ordinary', 'restricted_safety')`),
  check("moderation_evidence_hash_check", sql`char_length(${table.integritySha256}) = 64`),
  check("moderation_evidence_quarantine_check", sql`${table.classification} <> 'restricted_safety' OR ${table.quarantinedAt} IS NOT NULL`),
]);

export const moderationEvidenceAccess = pgTable("moderation_evidence_access", {
  id: uuid("id").defaultRandom().primaryKey(),
  evidenceId: uuid("evidence_id").notNull().references(() => moderationEvidence.id, { onDelete: "restrict" }),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  actorRole: text("actor_role").notNull(),
  purposeCode: varchar("purpose_code", { length: 80 }).notNull(),
  accessedAt: timestamptz("accessed_at").defaultNow().notNull(),
}, (table) => [
  index("moderation_evidence_access_evidence_idx").on(table.evidenceId, table.accessedAt),
  index("moderation_evidence_access_actor_idx").on(table.actorUserId, table.accessedAt),
  check("moderation_evidence_access_role_check", sql`${table.actorRole} IN ('case_worker', 'safety_specialist', 'legal_reviewer')`),
]);

export const moderationMediaCopies = pgTable("moderation_media_copies", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "restrict" }),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  subjectUserId: uuid("subject_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  photoId: uuid("photo_id").notNull().references(() => profilePhotos.id, { onDelete: "restrict" }),
  sourceObjectKey: text("source_object_key").notNull(),
  sourceObjectVersion: text("source_object_version").notNull(),
  sourceObjectEtag: text("source_object_etag").notNull(),
  objectKey: text("object_key").notNull().unique(),
  objectVersion: text("object_version").notNull(),
  objectEtag: text("object_etag").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("moderation_media_copies_report_photo_unique").on(table.reportId, table.photoId),
  index("moderation_media_copies_case_idx").on(table.caseId, table.createdAt),
]);

export const moderationMediaHolds = pgTable("moderation_media_holds", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "restrict" }),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  subjectUserId: uuid("subject_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  photoId: uuid("photo_id").notNull().references(() => profilePhotos.id, { onDelete: "restrict" }),
  evidenceCopyId: uuid("evidence_copy_id").references(() => moderationMediaCopies.id, { onDelete: "restrict" }),
  objectKey: text("object_key").notNull(),
  objectVersion: text("object_version").notNull(),
  snapshotSha256: varchar("snapshot_sha256", { length: 64 }).notNull(),
  preserveUntil: timestamptz("preserve_until").notNull(),
  active: boolean("active").default(true).notNull(),
  releasedAt: timestamptz("released_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("moderation_media_holds_report_photo_unique").on(table.reportId, table.photoId),
  index("moderation_media_holds_photo_active_idx").on(table.photoId, table.active, table.preserveUntil),
  check("moderation_media_holds_hash_check", sql`char_length(${table.snapshotSha256}) = 64`),
  check("moderation_media_holds_release_check", sql`
    (${table.active} AND ${table.releasedAt} IS NULL)
    OR (NOT ${table.active} AND ${table.releasedAt} IS NOT NULL)
  `),
]);

export const moderationAuditEvents = pgTable("moderation_audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
  actorRole: text("actor_role").notNull(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  summary: jsonb("summary").$type<Record<string, string | number | boolean | null>>().notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  index("moderation_audit_case_created_idx").on(table.caseId, table.createdAt, table.id),
  check("moderation_audit_actor_role_check", sql`${table.actorRole} IN ('system', 'case_worker', 'safety_specialist', 'appeal_reviewer', 'legal_reviewer')`),
]);

export const moderationOutboxEvents = pgTable("moderation_outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
  payload: jsonb("payload").$type<Record<string, string | number | boolean | null>>().notNull(),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  publishedAt: timestamptz("published_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("moderation_outbox_dedupe_unique").on(table.dedupeKey),
  index("moderation_outbox_claim_idx").on(table.status, table.availableAt),
  check("moderation_outbox_status_check", sql`${table.status} IN ('pending', 'processing', 'published', 'failed')`),
  check("moderation_outbox_attempts_check", sql`${table.attempts} >= 0`),
]);

export const safetyAlerts = pgTable("safety_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  designatedRole: text("designated_role").default("safety_specialist").notNull(),
  severity: text("severity").default("emergency").notNull(),
  status: text("status").default("pending").notNull(),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  acknowledgedAt: timestamptz("acknowledged_at"),
}, (table) => [
  unique("safety_alerts_dedupe_unique").on(table.dedupeKey),
  index("safety_alerts_queue_idx").on(table.designatedRole, table.status, table.createdAt),
  check("safety_alerts_role_check", sql`${table.designatedRole} = 'safety_specialist'`),
  check("safety_alerts_severity_check", sql`${table.severity} = 'emergency'`),
  check("safety_alerts_status_check", sql`${table.status} IN ('pending', 'acknowledged', 'closed')`),
]);

export const legalWorkflowTasks = pgTable("legal_workflow_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  jurisdictionCode: varchar("jurisdiction_code", { length: 8 }).notNull(),
  workflowCode: varchar("workflow_code", { length: 80 }).notNull(),
  status: text("status").default("pending").notNull(),
  dueAt: timestamptz("due_at").notNull(),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  completedAt: timestamptz("completed_at"),
}, (table) => [
  unique("legal_workflow_tasks_dedupe_unique").on(table.dedupeKey),
  index("legal_workflow_tasks_queue_idx").on(table.jurisdictionCode, table.status, table.dueAt),
  check("legal_workflow_tasks_status_check", sql`${table.status} IN ('pending', 'in_progress', 'completed', 'not_required')`),
  check("legal_workflow_tasks_jurisdiction_check", sql`char_length(${table.jurisdictionCode}) BETWEEN 2 AND 8`),
]);

export const userRestrictions = pgTable("user_restrictions", {
  id: uuid("id").defaultRandom().primaryKey(),
  subjectUserId: uuid("subject_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  sourceCaseId: uuid("source_case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  scope: text("scope").notNull(),
  reasonCode: varchar("reason_code", { length: 80 }).notNull(),
  expiryPolicy: text("expiry_policy").default("fixed").notNull(),
  active: boolean("active").default(true).notNull(),
  startsAt: timestamptz("starts_at").defaultNow().notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("user_restrictions_case_scope_unique").on(table.sourceCaseId, table.scope),
  index("user_restrictions_subject_scope_active_idx").on(table.subjectUserId, table.scope, table.active, table.expiresAt),
  check("user_restrictions_scope_check", sql`${table.scope} IN ('all_interactions', 'messaging', 'discovery')`),
  check("user_restrictions_expiry_policy_check", sql`${table.expiryPolicy} IN ('fixed', 'indefinite_review')`),
  check("user_restrictions_window_check", sql`${table.expiresAt} > ${table.startsAt}`),
  check("user_restrictions_revocation_check", sql`(${table.active} AND ${table.revokedAt} IS NULL) OR (NOT ${table.active} AND ${table.revokedAt} IS NOT NULL)`),
]);

export const moderationContentQuarantines = pgTable("moderation_content_quarantines", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "restrict" }),
  contentType: text("content_type").notNull(),
  contentId: uuid("content_id").notNull(),
  reasonCode: varchar("reason_code", { length: 80 }).notNull(),
  active: boolean("active").default(true).notNull(),
  startsAt: timestamptz("starts_at").defaultNow().notNull(),
  preserveUntil: timestamptz("preserve_until").notNull(),
  releasedAt: timestamptz("released_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("moderation_content_quarantines_active_unique").on(table.contentType, table.contentId)
    .where(sql`${table.active}`),
  index("moderation_content_quarantines_lookup_idx")
    .on(table.contentType, table.contentId, table.active, table.preserveUntil),
  index("moderation_content_quarantines_case_idx").on(table.caseId, table.createdAt),
  check("moderation_content_quarantines_type_check", sql`${table.contentType} IN ('profile', 'message', 'photo')`),
  check("moderation_content_quarantines_window_check", sql`${table.preserveUntil} > ${table.startsAt}`),
  check("moderation_content_quarantines_release_check", sql`
    (${table.active} AND ${table.releasedAt} IS NULL)
    OR (NOT ${table.active} AND ${table.releasedAt} IS NOT NULL)
  `),
]);
