import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid,
  varchar } from "drizzle-orm/pg-core";

import { users } from "./auth";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz("created_at").defaultNow().notNull();
const updatedAt = () => timestamptz("updated_at").defaultNow().notNull().$onUpdate(() => new Date());

export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  locale: varchar("locale", { length: 10 }).default("en").notNull(),
  timeZone: varchar("time_zone", { length: 100 }).default("UTC").notNull(),
  marketingEnabled: boolean("marketing_enabled").default(false).notNull(),
  emailEnabled: boolean("email_enabled").default(true).notNull(),
  smsEnabled: boolean("sms_enabled").default(false).notNull(),
  inAppEnabled: boolean("in_app_enabled").default(true).notNull(),
  quietStartHour: integer("quiet_start_hour"),
  quietEndHour: integer("quiet_end_hour"),
  updatedAt: updatedAt(),
}, (table) => [
  check("notification_preferences_locale_check", sql`${table.locale} IN ('en', 'zh-CN')`),
  check("notification_preferences_quiet_hours_check", sql`
    (${table.quietStartHour} IS NULL AND ${table.quietEndHour} IS NULL)
    OR (${table.quietStartHour} BETWEEN 0 AND 23 AND ${table.quietEndHour} BETWEEN 0 AND 23
      AND ${table.quietStartHour} <> ${table.quietEndHour})`),
]);

export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  dedupeKey: varchar("dedupe_key", { length: 180 }).notNull(),
  category: text("category").notNull(),
  templateKey: varchar("template_key", { length: 160 }).notNull(),
  locale: varchar("locale", { length: 10 }).notNull(),
  channels: text("channels").array().notNull(),
  payload: jsonb("payload").$type<Record<string, string>>().default({}).notNull(),
  payloadEncrypted: text("payload_encrypted"),
  encryptionKeyId: varchar("encryption_key_id", { length: 120 }),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(5).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  manualReviewAt: timestamptz("manual_review_at"),
  sentAt: timestamptz("sent_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("notification_outbox_dedupe_unique").on(table.userId, table.dedupeKey),
  index("notification_outbox_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  check("notification_outbox_category_check", sql`${table.category} IN ('security', 'transactional', 'marketing')`),
  check("notification_outbox_locale_check", sql`${table.locale} IN ('en', 'zh-CN')`),
  check("notification_outbox_status_check", sql`${table.status} IN ('pending', 'processing', 'sent', 'suppressed', 'manual_review')`),
  check("notification_outbox_attempts_check", sql`${table.attempts} BETWEEN 0 AND ${table.maxAttempts} AND ${table.maxAttempts} BETWEEN 1 AND 10`),
  check("notification_outbox_lease_shape_check", sql`
    (${table.status} = 'processing' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'processing' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)`),
  check("notification_outbox_payload_encryption_check", sql`
    (${table.payloadEncrypted} IS NULL AND ${table.encryptionKeyId} IS NULL)
    OR (${table.payloadEncrypted} IS NOT NULL AND ${table.encryptionKeyId} IS NOT NULL)`),
]);

export const notificationInbox = pgTable("notification_inbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  outboxId: uuid("outbox_id").notNull().references(() => notificationOutbox.id, { onDelete: "restrict" }),
  providerIdempotencyKey: varchar("provider_idempotency_key", { length: 180 }).notNull(),
  templateKey: varchar("template_key", { length: 160 }).notNull(),
  locale: varchar("locale", { length: 10 }).notNull(),
  payload: jsonb("payload").$type<Record<string, string>>().default({}).notNull(),
  deliveredAt: timestamptz("delivered_at").defaultNow().notNull(),
  readAt: timestamptz("read_at"),
}, (table) => [
  unique("notification_inbox_provider_idempotency_unique").on(table.providerIdempotencyKey),
  index("notification_inbox_owner_created_idx").on(table.userId, table.deliveredAt),
  check("notification_inbox_locale_check", sql`${table.locale} IN ('en', 'zh-CN')`),
]);

export const privacyExportJobs = pgTable("privacy_export_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  objectKey: text("object_key"),
  preparedArtifactEncrypted: text("prepared_artifact_encrypted"),
  preparedIntegritySha256: varchar("prepared_integrity_sha256", { length: 64 }),
  objectVersion: varchar("object_version", { length: 255 }),
  integritySha256: varchar("integrity_sha256", { length: 64 }),
  encryptionKeyId: varchar("encryption_key_id", { length: 120 }),
  schemaVersion: integer("schema_version").default(1).notNull(),
  expiresAt: timestamptz("expires_at"),
  completedAt: timestamptz("completed_at"),
  downloadTokenHash: varchar("download_token_hash", { length: 64 }),
  downloadTokenExpiresAt: timestamptz("download_token_expires_at"),
  downloadTokenUsedAt: timestamptz("download_token_used_at"),
  downloadTokenRevokedAt: timestamptz("download_token_revoked_at"),
  downloadLeaseId: uuid("download_lease_id"),
  downloadLeaseExpiresAt: timestamptz("download_lease_expires_at"),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  manualReviewAt: timestamptz("manual_review_at"),
  cleanupStatus: text("cleanup_status").default("pending").notNull(),
  cleanupAttempts: integer("cleanup_attempts").default(0).notNull(),
  cleanupAvailableAt: timestamptz("cleanup_available_at").defaultNow().notNull(),
  cleanupLeaseId: uuid("cleanup_lease_id"),
  cleanupLeaseExpiresAt: timestamptz("cleanup_lease_expires_at"),
  cleanupLastErrorCode: varchar("cleanup_last_error_code", { length: 80 }),
  cleanupManualReviewAt: timestamptz("cleanup_manual_review_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("privacy_export_jobs_owner_idempotency_unique").on(table.userId, table.idempotencyKey),
  unique("privacy_export_jobs_object_version_unique").on(table.objectKey, table.objectVersion),
  unique("privacy_export_jobs_download_token_unique").on(table.downloadTokenHash),
  index("privacy_export_jobs_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  index("privacy_export_jobs_expiry_idx").on(table.status, table.expiresAt),
  check("privacy_export_jobs_status_check", sql`${table.status} IN ('pending', 'processing', 'ready', 'failed', 'expired', 'manual_review')`),
  check("privacy_export_jobs_attempts_check", sql`${table.attempts} BETWEEN 0 AND 5`),
  check("privacy_export_jobs_cleanup_attempts_check", sql`${table.cleanupAttempts} BETWEEN 0 AND 5`),
  check("privacy_export_jobs_cleanup_status_check", sql`${table.cleanupStatus} IN ('pending', 'processing', 'completed', 'manual_review')`),
  check("privacy_export_jobs_lease_shape_check", sql`
    (${table.status} = 'processing' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'processing' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)`),
  check("privacy_export_jobs_cleanup_lease_shape_check", sql`
    (${table.cleanupStatus} = 'processing' AND ${table.cleanupLeaseId} IS NOT NULL AND ${table.cleanupLeaseExpiresAt} IS NOT NULL)
    OR (${table.cleanupStatus} <> 'processing' AND ${table.cleanupLeaseId} IS NULL AND ${table.cleanupLeaseExpiresAt} IS NULL)`),
  check("privacy_export_jobs_integrity_check", sql`${table.integritySha256} IS NULL OR ${table.integritySha256} ~ '^[a-f0-9]{64}$'`),
  check("privacy_export_jobs_prepared_artifact_check", sql`
    (${table.preparedArtifactEncrypted} IS NULL AND ${table.preparedIntegritySha256} IS NULL)
    OR (${table.preparedArtifactEncrypted} IS NOT NULL AND ${table.preparedIntegritySha256} ~ '^[a-f0-9]{64}$')`),
  check("privacy_export_jobs_download_token_check", sql`
    (${table.downloadTokenHash} IS NULL AND ${table.downloadTokenExpiresAt} IS NULL)
    OR (${table.downloadTokenHash} ~ '^[a-f0-9]{64}$' AND ${table.downloadTokenExpiresAt} IS NOT NULL
      AND NOT (${table.downloadTokenUsedAt} IS NOT NULL AND ${table.downloadTokenRevokedAt} IS NOT NULL))`),
  check("privacy_export_jobs_download_lease_shape_check", sql`
    (${table.downloadLeaseId} IS NULL AND ${table.downloadLeaseExpiresAt} IS NULL)
    OR (${table.downloadLeaseId} IS NOT NULL AND ${table.downloadLeaseExpiresAt} IS NOT NULL
      AND ${table.status} = 'ready' AND ${table.downloadTokenHash} IS NOT NULL
      AND ${table.downloadTokenUsedAt} IS NULL AND ${table.downloadTokenRevokedAt} IS NULL)`),
  check("privacy_export_jobs_ready_shape_check", sql`${table.status} <> 'ready' OR (
    ${table.objectKey} IS NOT NULL AND ${table.objectVersion} IS NOT NULL AND ${table.integritySha256} IS NOT NULL
    AND ${table.encryptionKeyId} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`),
]);

export const accountDeletionRequests = pgTable("account_deletion_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  status: text("status").default("cooling_off").notNull(),
  executeAt: timestamptz("execute_at").notNull(),
  originalProfileDiscoverable: boolean("original_profile_discoverable").default(false).notNull(),
  cancellationTokenHash: varchar("cancellation_token_hash", { length: 64 }).notNull(),
  cancellationTokenExpiresAt: timestamptz("cancellation_token_expires_at").notNull(),
  cancellationTokenUsedAt: timestamptz("cancellation_token_used_at"),
  cancellationTokenRevokedAt: timestamptz("cancellation_token_revoked_at"),
  preserveHeldRecords: boolean("preserve_held_records").default(false).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  canceledAt: timestamptz("canceled_at"),
  completedAt: timestamptz("completed_at"),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  manualReviewAt: timestamptz("manual_review_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("account_deletion_requests_owner_idempotency_unique").on(table.userId, table.idempotencyKey),
  unique("account_deletion_requests_cancellation_token_unique").on(table.cancellationTokenHash),
  uniqueIndex("account_deletion_requests_active_owner_unique").on(table.userId)
    .where(sql`${table.status} IN ('cooling_off', 'processing')`),
  index("account_deletion_requests_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  check("account_deletion_requests_status_check", sql`${table.status} IN ('cooling_off', 'processing', 'canceled', 'completed', 'manual_review')`),
  check("account_deletion_requests_attempts_check", sql`${table.attempts} BETWEEN 0 AND 5`),
  check("account_deletion_requests_cooling_window_check",
    sql`${table.executeAt} >= ${table.createdAt} + interval '30 days'`),
  check("account_deletion_requests_available_at_check", sql`${table.availableAt} >= ${table.executeAt}`),
  check("account_deletion_requests_cancellation_token_check", sql`
    ${table.cancellationTokenHash} ~ '^[a-f0-9]{64}$'
    AND ${table.cancellationTokenExpiresAt} > ${table.createdAt}
    AND ${table.cancellationTokenExpiresAt} <= ${table.executeAt}
    AND NOT (${table.cancellationTokenUsedAt} IS NOT NULL AND ${table.cancellationTokenRevokedAt} IS NOT NULL)`),
  check("account_deletion_requests_lease_shape_check", sql`
    (${table.status} = 'processing' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'processing' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)`),
  check("account_deletion_requests_terminal_shape_check", sql`
    (${table.status} = 'canceled' AND ${table.canceledAt} IS NOT NULL)
    OR (${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL)
    OR ${table.status} IN ('cooling_off', 'processing', 'manual_review')`),
]);

export const privacyRetentionLedger = pgTable("privacy_retention_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  deletionRequestId: uuid("deletion_request_id").notNull()
    .references(() => accountDeletionRequests.id, { onDelete: "restrict" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  recordType: varchar("record_type", { length: 80 }).notNull(),
  recordId: varchar("record_id", { length: 255 }).notNull(),
  legalBasis: varchar("legal_basis", { length: 80 }).notNull(),
  restrictedLocator: jsonb("restricted_locator").$type<Record<string, string>>().notNull(),
  preserveUntil: timestamptz("preserve_until"),
  createdAt: createdAt(),
}, (table) => [
  unique("privacy_retention_ledger_record_unique").on(table.deletionRequestId, table.recordType, table.recordId),
  index("privacy_retention_ledger_owner_idx").on(table.userId, table.createdAt),
  check("privacy_retention_ledger_basis_check", sql`${table.legalBasis} IN ('legal_hold', 'moderation', 'billing_ledger')`),
]);

export const privacyAuditEvents = pgTable("privacy_audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  deletionRequestId: uuid("deletion_request_id").notNull()
    .references(() => accountDeletionRequests.id, { onDelete: "restrict" }),
  eventType: text("event_type").notNull(),
  details: jsonb("details").$type<Record<string, string>>().default({}).notNull(),
  occurredAt: timestamptz("occurred_at").defaultNow().notNull(),
}, (table) => [
  unique("privacy_audit_events_request_type_unique").on(table.deletionRequestId, table.eventType),
  index("privacy_audit_events_owner_idx").on(table.userId, table.occurredAt),
  check("privacy_audit_events_type_check", sql`${table.eventType} IN ('deletion_requested','deletion_canceled','deletion_completed')`),
]);

export const privacyWorkflowOutbox = pgTable("privacy_workflow_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  deletionRequestId: uuid("deletion_request_id").references(() => accountDeletionRequests.id, { onDelete: "restrict" }),
  exportJobId: uuid("export_job_id").references(() => privacyExportJobs.id, { onDelete: "restrict" }),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 180 }).notNull(),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  manualReviewAt: timestamptz("manual_review_at"),
  createdAt: createdAt(),
}, (table) => [
  unique("privacy_workflow_outbox_dedupe_unique").on(table.dedupeKey),
  index("privacy_workflow_outbox_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  check("privacy_workflow_outbox_type_check", sql`${table.eventType} IN ('export_requested', 'export_ready', 'deletion_requested', 'renewal_cancel_requested', 'deletion_canceled', 'deletion_completed')`),
  check("privacy_workflow_outbox_status_check", sql`${table.status} IN ('pending', 'processing', 'done', 'manual_review')`),
  check("privacy_workflow_outbox_attempts_check", sql`${table.attempts} BETWEEN 0 AND 5`),
  check("privacy_workflow_outbox_lease_shape_check", sql`
    (${table.status} = 'processing' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'processing' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)`),
]);
