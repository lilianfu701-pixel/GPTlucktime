import { sql } from "drizzle-orm";
import {
  check,
  bigint,
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
import { billingPayments } from "./billing";
import { moderationCases, moderationEvidence, reports } from "./moderation";
import { messages } from "./messaging";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz("created_at").defaultNow().notNull();
const roleCheck = (column: { name: string }) => sql`${column} IN ('support','moderation','safety','operations','finance','super_admin')`;

export const adminRoleAssignments = pgTable("admin_role_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  role: text("role").notNull(),
  assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  active: text("active").default("active").notNull(),
  createdAt: createdAt(),
  revokedAt: timestamptz("revoked_at"),
}, (table) => [
  uniqueIndex("admin_role_assignments_active_unique").on(table.userId, table.role)
    .where(sql`${table.active} = 'active'`),
  index("admin_role_assignments_user_idx").on(table.userId, table.active),
  check("admin_role_assignments_role_check", roleCheck(table.role)),
  check("admin_role_assignments_active_check", sql`${table.active} IN ('active','revoked')`),
  check("admin_role_assignments_revoked_check", sql`(${table.active} = 'active' AND ${table.revokedAt} IS NULL) OR (${table.active} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`),
]);

export const adminSessions = pgTable("admin_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  roleAssignmentId: uuid("role_assignment_id").notNull()
    .references(() => adminRoleAssignments.id, { onDelete: "restrict" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  mfaVerifiedAt: timestamptz("mfa_verified_at"),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
  lastSeenAt: timestamptz("last_seen_at").defaultNow().notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("admin_sessions_token_hash_unique").on(table.tokenHash),
  index("admin_sessions_user_expiry_idx").on(table.userId, table.expiresAt),
  check("admin_sessions_token_hash_check", sql`char_length(${table.tokenHash}) = 64`),
  check("admin_sessions_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export type AdminApprovalPayload = unknown;

export const adminApprovalRequests = pgTable("admin_approval_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  requesterUserId: uuid("requester_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  requesterAdminSessionId: uuid("requester_admin_session_id").notNull()
    .references(() => adminSessions.id, { onDelete: "restrict" }),
  requestId: uuid("request_id").notNull(),
  ipHash: varchar("ip_hash", { length: 64 }).notNull(),
  action: text("action").notNull(),
  requestPermission: varchar("request_permission", { length: 100 }).notNull(),
  approvalPermission: varchar("approval_permission", { length: 100 }).notNull(),
  targetType: varchar("target_type", { length: 80 }).notNull(),
  targetId: varchar("target_id", { length: 200 }).notNull(),
  payloadVersion: integer("payload_version").notNull(),
  payload: jsonb("payload").$type<AdminApprovalPayload>().notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  status: text("status").default("pending").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  executedAt: timestamptz("executed_at"),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  manualReviewAt: timestamptz("manual_review_at"),
  createdAt: createdAt(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  index("admin_approval_requests_queue_idx").on(table.status, table.expiresAt, table.createdAt, table.id),
  check("admin_approval_requests_action_check", sql`${table.action} IN ('bulk_suspension','sensitive_export','manual_refund','payment_configuration','safety_evidence_access')`),
  check("admin_approval_requests_version_check", sql`${table.payloadVersion} > 0`),
  check("admin_approval_requests_hash_check", sql`char_length(${table.payloadHash}) = 64`),
  check("admin_approval_requests_ip_hash_check", sql`char_length(${table.ipHash}) = 64`),
  check("admin_approval_requests_reason_check", sql`char_length(${table.reason}) BETWEEN 1 AND 500`),
  check("admin_approval_requests_status_check", sql`${table.status} IN ('pending','approved','rejected','executing','executed','expired','failed')`),
  check("admin_approval_requests_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  check("admin_approval_requests_attempts_check", sql`${table.attempts} BETWEEN 0 AND 20`),
  check("admin_approval_requests_lease_shape_check", sql`
    (${table.status} = 'executing' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'executing' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)
  `),
]);

export const adminApprovalDecisions = pgTable("admin_approval_decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  requestId: uuid("request_id").notNull().references(() => adminApprovalRequests.id, { onDelete: "restrict" }),
  approverUserId: uuid("approver_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  approverAdminSessionId: uuid("approver_admin_session_id").notNull()
    .references(() => adminSessions.id, { onDelete: "restrict" }),
  permission: varchar("permission", { length: 100 }).notNull(),
  decision: text("decision").notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("admin_approval_decisions_request_unique").on(table.requestId),
  check("admin_approval_decisions_decision_check", sql`${table.decision} IN ('approved','rejected')`),
  check("admin_approval_decisions_reason_check", sql`char_length(${table.reason}) BETWEEN 1 AND 500`),
]);

export const adminBulkActionItems = pgTable("admin_bulk_action_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  approvalRequestId: uuid("approval_request_id").notNull()
    .references(() => adminApprovalRequests.id, { onDelete: "restrict" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  expectedVersion: integer("expected_version").notNull(),
  resultActionId: uuid("result_action_id"),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  createdAt: createdAt(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("admin_bulk_action_items_request_target_unique").on(table.approvalRequestId, table.targetUserId),
  index("admin_bulk_action_items_work_idx").on(table.approvalRequestId, table.status, table.id),
  check("admin_bulk_action_items_version_check", sql`${table.expectedVersion} >= 0`),
  check("admin_bulk_action_items_status_check", sql`${table.status} IN ('pending','claimed','executed','retry','manual_review')`),
  check("admin_bulk_action_items_attempts_check", sql`${table.attempts} BETWEEN 0 AND 20`),
]);

export const adminExportJobs = pgTable("admin_export_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  approvalRequestId: uuid("approval_request_id").notNull()
    .references(() => adminApprovalRequests.id, { onDelete: "restrict" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  exportKind: varchar("export_kind", { length: 80 }).notNull(),
  scope: jsonb("scope").$type<Readonly<Record<string, unknown>>>().notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  status: text("status").default("queued").notNull(),
  objectKey: varchar("object_key", { length: 512 }),
  artifactVersion: integer("artifact_version"),
  storageVersionId: varchar("storage_version_id", { length: 255 }),
  contentHash: varchar("content_hash", { length: 64 }),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  expiresAt: timestamptz("expires_at"),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  manualReviewAt: timestamptz("manual_review_at"),
  createdAt: createdAt(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("admin_export_jobs_approval_unique").on(table.approvalRequestId),
  index("admin_export_jobs_queue_idx").on(table.status, table.createdAt, table.id),
  check("admin_export_jobs_status_check", sql`${table.status} IN ('queued','processing','ready','purging','purged','failed','manual_review')`),
  check("admin_export_jobs_hash_check", sql`char_length(${table.payloadHash}) = 64`),
  check("admin_export_jobs_attempts_check", sql`${table.attempts} BETWEEN 0 AND 20`),
  check("admin_export_jobs_ready_shape_check", sql`${table.status} NOT IN ('ready','purging','purged') OR
    (${table.objectKey} IS NOT NULL AND ${table.artifactVersion} = 1 AND ${table.storageVersionId} IS NOT NULL
      AND char_length(${table.contentHash}) = 64 AND ${table.sizeBytes} > 0 AND ${table.expiresAt} > ${table.createdAt})`),
  check("admin_export_jobs_lease_shape_check", sql`
    (${table.status} IN ('processing','purging') AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} NOT IN ('processing','purging') AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)`),
]);

export const adminRefundIntents = pgTable("admin_refund_intents", {
  id: uuid("id").defaultRandom().primaryKey(),
  approvalRequestId: uuid("approval_request_id").notNull()
    .references(() => adminApprovalRequests.id, { onDelete: "restrict" }),
  paymentId: uuid("payment_id").notNull().references(() => billingPayments.id, { onDelete: "restrict" }),
  providerPaymentId: varchar("provider_payment_id", { length: 255 }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  status: text("status").default("pending").notNull(),
  providerRefundId: varchar("provider_refund_id", { length: 255 }),
  attempts: integer("attempts").default(0).notNull(),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  createdAt: createdAt(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("admin_refund_intents_approval_unique").on(table.approvalRequestId),
  unique("admin_refund_intents_idempotency_unique").on(table.idempotencyKey),
  unique("admin_refund_intents_provider_refund_unique").on(table.providerRefundId),
  index("admin_refund_intents_retry_idx").on(table.status, table.updatedAt),
  check("admin_refund_intents_status_check", sql`${table.status} IN ('pending','provider_submitted','manual_review')`),
  check("admin_refund_intents_amount_check", sql`${table.amount} BETWEEN 1 AND 1000000000`),
]);

export const adminSafetyAccessGrants = pgTable("admin_safety_access_grants", {
  id: uuid("id").defaultRandom().primaryKey(),
  approvalRequestId: uuid("approval_request_id").notNull()
    .references(() => adminApprovalRequests.id, { onDelete: "restrict" }),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id, { onDelete: "restrict" }),
  reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "restrict" }),
  evidenceId: uuid("evidence_id").references(() => moderationEvidence.id, { onDelete: "restrict" }),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "restrict" }),
  expiresAt: timestamptz("expires_at").notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("admin_safety_access_grants_approval_unique").on(table.approvalRequestId),
  index("admin_safety_access_grants_lookup_idx").on(table.actorUserId, table.caseId, table.expiresAt),
  check("admin_safety_access_grants_target_check", sql`num_nonnulls(${table.evidenceId}, ${table.messageId}) = 1`),
  check("admin_safety_access_grants_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const adminUserActionVersions = pgTable("admin_user_action_versions", {
  targetUserId: uuid("target_user_id").primaryKey().references(() => users.id, { onDelete: "restrict" }),
  version: integer("version").default(0).notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [check("admin_user_action_versions_version_check", sql`${table.version} >= 0`)]);

export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  permission: varchar("permission", { length: 100 }).notNull(),
  targetType: varchar("target_type", { length: 80 }).notNull(),
  targetId: varchar("target_id", { length: 200 }).notNull(),
  beforeDiff: jsonb("before_diff").notNull(),
  afterDiff: jsonb("after_diff").notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  requestId: uuid("request_id").notNull(),
  ipHash: varchar("ip_hash", { length: 64 }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  index("admin_audit_logs_target_idx").on(table.targetType, table.targetId, table.createdAt, table.id),
  index("admin_audit_logs_actor_idx").on(table.actorUserId, table.createdAt, table.id),
  check("admin_audit_logs_hash_check", sql`char_length(${table.ipHash}) = 64`),
  check("admin_audit_logs_reason_check", sql`char_length(${table.reason}) BETWEEN 1 AND 500`),
]);

export const adminConfigChanges = pgTable("admin_config_changes", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  approvalRequestId: uuid("approval_request_id").references(() => adminApprovalRequests.id, { onDelete: "restrict" }),
  configType: varchar("config_type", { length: 80 }).notNull(),
  targetId: varchar("target_id", { length: 200 }).notNull(),
  previousVersion: integer("previous_version").notNull(),
  newVersion: integer("new_version").notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("admin_config_changes_actor_key_unique").on(table.actorUserId, table.idempotencyKey),
  index("admin_config_changes_queue_idx").on(table.createdAt, table.id),
  check("admin_config_changes_version_check", sql`${table.previousVersion} >= 0 AND ${table.newVersion} = ${table.previousVersion} + 1`),
  check("admin_config_changes_hash_check", sql`char_length(${table.payloadHash}) = 64`),
]);

export const adminActionIdempotency = pgTable("admin_action_idempotency", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  targetType: varchar("target_type", { length: 80 }).notNull(),
  targetId: varchar("target_id", { length: 200 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  expectedVersion: integer("expected_version").notNull(),
  result: jsonb("result").notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("admin_action_idempotency_actor_key_unique").on(table.actorUserId, table.idempotencyKey),
  check("admin_action_idempotency_hash_check", sql`char_length(${table.payloadHash}) = 64`),
  check("admin_action_idempotency_version_check", sql`${table.expectedVersion} >= 0`),
]);

export const adminOutboxEvents = pgTable("admin_outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  approvalRequestId: uuid("approval_request_id").notNull().references(() => adminApprovalRequests.id, { onDelete: "restrict" }),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
  aggregateId: varchar("aggregate_id", { length: 200 }).notNull(),
  requestId: uuid("request_id").notNull(),
  ipHash: varchar("ip_hash", { length: 64 }).notNull(),
  payload: jsonb("payload").$type<Readonly<Record<string, unknown>>>().notNull(),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  deliveredAt: timestamptz("delivered_at"),
  manualReviewAt: timestamptz("manual_review_at"),
  createdAt: createdAt(),
}, (table) => [
  index("admin_outbox_events_approval_idx").on(table.approvalRequestId, table.createdAt, table.id),
  index("admin_outbox_events_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  check("admin_outbox_events_status_check", sql`${table.status} IN ('pending','retrying','processing','delivered','failed')`),
  check("admin_outbox_events_attempts_check", sql`${table.attempts} BETWEEN 0 AND 20`),
  check("admin_outbox_events_hash_check", sql`char_length(${table.ipHash}) = 64`),
  check("admin_outbox_events_lease_check", sql`(${table.status} = 'processing' AND ${table.leaseId} IS NOT NULL
    AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'processing' AND ${table.leaseId} IS NULL
    AND ${table.leaseExpiresAt} IS NULL)`),
  check("admin_outbox_events_terminal_check", sql`(${table.status} = 'delivered' AND ${table.deliveredAt} IS NOT NULL
    AND ${table.lastErrorCode} IS NULL AND ${table.manualReviewAt} IS NULL)
    OR (${table.status} = 'failed' AND ${table.deliveredAt} IS NULL AND ${table.lastErrorCode} IS NOT NULL
      AND ${table.manualReviewAt} IS NOT NULL)
    OR (${table.status} NOT IN ('delivered','failed') AND ${table.deliveredAt} IS NULL AND ${table.manualReviewAt} IS NULL)`),
]);
