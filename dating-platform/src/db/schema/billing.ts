import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid, varchar,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { users } from "./auth";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const currencyCheck = (column: { getSQL(): unknown }) => sql`${column} ~ '^[A-Z]{3}$'`;

export const billingPlans = pgTable("billing_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  planRef: varchar("plan_ref", { length: 80 }).notNull(),
  version: integer("version").notNull(),
  nameKey: varchar("name_key", { length: 120 }).notNull(),
  descriptionKey: varchar("description_key", { length: 120 }).notNull(),
  active: boolean("active").default(true).notNull(),
  effectiveAt: timestamptz("effective_at").notNull(),
  expiresAt: timestamptz("expires_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_plans_ref_version_unique").on(table.planRef, table.version),
  index("billing_plans_public_idx").on(table.active, table.effectiveAt, table.expiresAt, table.planRef),
  check("billing_plans_ref_check", sql`${table.planRef} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`),
  check("billing_plans_version_check", sql`${table.version} > 0`),
  check("billing_plans_window_check", sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.effectiveAt}`),
]);

export const billingPrices = pgTable("billing_prices", {
  id: uuid("id").defaultRandom().primaryKey(),
  planId: uuid("plan_id").notNull().references(() => billingPlans.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  countryCode: varchar("country_code", { length: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  unitAmount: bigint("unit_amount", { mode: "number" }).notNull(),
  interval: text("interval").notNull(),
  intervalCount: integer("interval_count").notNull(),
  taxMode: text("tax_mode").notNull(),
  provider: text("provider").default("stripe").notNull(),
  providerPriceId: varchar("provider_price_id", { length: 255 }).notNull(),
  active: boolean("active").default(true).notNull(),
  effectiveAt: timestamptz("effective_at").notNull(),
  expiresAt: timestamptz("expires_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_prices_plan_country_currency_version_unique")
    .on(table.planId, table.countryCode, table.currency, table.version),
  unique("billing_prices_provider_price_unique").on(table.provider, table.providerPriceId),
  index("billing_prices_selection_idx")
    .on(table.countryCode, table.currency, table.active, table.effectiveAt, table.expiresAt),
  check("billing_prices_version_check", sql`${table.version} > 0`),
  check("billing_prices_country_check", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
  check("billing_prices_currency_check", currencyCheck(table.currency)),
  check("billing_prices_amount_check", sql`${table.unitAmount} BETWEEN 0 AND 1000000000`),
  check("billing_prices_interval_check", sql`${table.interval} IN ('monthly', 'quarterly', 'yearly')`),
  check("billing_prices_interval_count_check", sql`${table.intervalCount} BETWEEN 1 AND 36`),
  check("billing_prices_tax_mode_check", sql`${table.taxMode} IN ('inclusive', 'exclusive')`),
  check("billing_prices_provider_check", sql`${table.provider} = 'stripe'`),
  check("billing_prices_window_check", sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.effectiveAt}`),
]);

export const billingCustomers = pgTable("billing_customers", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "restrict" }),
  provider: text("provider").default("stripe").notNull(),
  providerCustomerId: varchar("provider_customer_id", { length: 255 }).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_customers_provider_mapping_unique").on(table.provider, table.providerCustomerId),
  unique("billing_customers_user_provider_unique").on(table.userId, table.providerCustomerId),
  check("billing_customers_provider_check", sql`${table.provider} = 'stripe'`),
]);

export const billingOrders = pgTable("billing_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  priceId: uuid("price_id").notNull().references(() => billingPrices.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  planRef: varchar("plan_ref", { length: 80 }).notNull(),
  planVersion: integer("plan_version").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: text("status").default("pending").notNull(),
  providerSessionId: varchar("provider_session_id", { length: 255 }),
  checkoutUrl: text("checkout_url"),
  providerFailureCount: integer("provider_failure_count").default(0).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_orders_user_idempotency_unique").on(table.userId, table.idempotencyKey),
  unique("billing_orders_id_user_unique").on(table.id, table.userId),
  unique("billing_orders_provider_session_unique").on(table.providerSessionId),
  index("billing_orders_owner_created_idx").on(table.userId, table.createdAt),
  check("billing_orders_request_hash_check", sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`),
  check("billing_orders_plan_version_check", sql`${table.planVersion} > 0`),
  check("billing_orders_amount_check", sql`${table.amount} BETWEEN 0 AND 1000000000`),
  check("billing_orders_currency_check", currencyCheck(table.currency)),
  check("billing_orders_status_check", sql`${table.status} IN ('pending', 'session_created', 'paid', 'failed', 'canceled', 'refunded', 'disputed', 'review_required')`),
  check("billing_orders_failure_count_check", sql`${table.providerFailureCount} BETWEEN 0 AND 100`),
]);

export const billingSubscriptions = pgTable("billing_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  orderId: uuid("order_id").references(() => billingOrders.id, { onDelete: "restrict" }),
  priceId: uuid("price_id").notNull().references(() => billingPrices.id, { onDelete: "restrict" }),
  planRef: varchar("plan_ref", { length: 80 }).notNull(),
  providerCustomerId: varchar("provider_customer_id", { length: 255 }).notNull(),
  providerSubscriptionId: varchar("provider_subscription_id", { length: 255 }).notNull(),
  status: text("status").notNull(),
  providerStatus: text("provider_status").default("active").notNull(),
  entitlementOverride: text("entitlement_override").default("none").notNull(),
  currentEntitlementPaymentId: uuid("current_entitlement_payment_id")
    .references((): AnyPgColumn => billingPayments.id, { onDelete: "restrict" }),
  providerObjectVersion: bigint("provider_object_version", { mode: "number" }).notNull(),
  providerEventCreatedAt: timestamptz("provider_event_created_at").notNull(),
  currentPeriodStart: timestamptz("current_period_start"),
  currentPeriodEnd: timestamptz("current_period_end"),
  graceEndsAt: timestamptz("grace_ends_at"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_subscriptions_provider_unique").on(table.providerSubscriptionId),
  unique("billing_subscriptions_order_unique").on(table.orderId),
  foreignKey({
    columns: [table.userId, table.providerCustomerId],
    foreignColumns: [billingCustomers.userId, billingCustomers.providerCustomerId],
    name: "billing_subscriptions_customer_owner_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orderId, table.userId],
    foreignColumns: [billingOrders.id, billingOrders.userId],
    name: "billing_subscriptions_order_owner_fk",
  }).onDelete("restrict"),
  index("billing_subscriptions_owner_status_idx").on(table.userId, table.status, table.currentPeriodEnd),
  check("billing_subscriptions_status_check", sql`${table.status} IN ('trialing', 'active', 'past_due', 'grace_period', 'disputed', 'revoked', 'canceled', 'expired')`),
  check("billing_subscriptions_provider_status_check", sql`${table.providerStatus} IN ('trialing', 'active', 'past_due', 'grace_period', 'canceled', 'expired')`),
  check("billing_subscriptions_override_check", sql`${table.entitlementOverride} IN ('none', 'dispute_open', 'dispute_lost', 'refund_full', 'duplicate_subscription')`),
  check("billing_subscriptions_effective_status_check", sql`
    (${table.entitlementOverride} = 'none' AND ${table.status} = ${table.providerStatus})
    OR (${table.entitlementOverride} = 'dispute_open' AND ${table.status} = 'disputed')
    OR (${table.entitlementOverride} = 'dispute_lost' AND ${table.status} = 'revoked')
    OR (${table.entitlementOverride} = 'refund_full' AND ${table.status} = 'expired')
    OR (${table.entitlementOverride} = 'duplicate_subscription' AND ${table.status} = 'revoked')
  `),
  check("billing_subscriptions_version_check", sql`${table.providerObjectVersion} >= 0`),
  check("billing_subscriptions_period_check", sql`${table.currentPeriodEnd} IS NULL OR ${table.currentPeriodStart} IS NOT NULL AND ${table.currentPeriodEnd} > ${table.currentPeriodStart}`),
  check("billing_subscriptions_grace_check", sql`${table.graceEndsAt} IS NULL OR ${table.providerStatus} IN ('past_due', 'grace_period')`),
]);

export const billingWebhookEvents = pgTable("billing_webhook_events", {
  providerEventId: varchar("provider_event_id", { length: 255 }).primaryKey(),
  eventType: varchar("event_type", { length: 120 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  objectId: varchar("object_id", { length: 255 }).notNull(),
  providerCreatedAt: timestamptz("provider_created_at").notNull(),
  outcome: text("outcome").notNull(),
  reviewReason: varchar("review_reason", { length: 180 }),
  receivedAt: timestamptz("received_at").defaultNow().notNull(),
  processedAt: timestamptz("processed_at").notNull(),
}, (table) => [
  index("billing_webhook_events_created_idx").on(table.providerCreatedAt),
  check("billing_webhook_events_hash_check", sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
  check("billing_webhook_events_outcome_check", sql`${table.outcome} IN ('processing', 'applied', 'stale', 'ignored')`),
]);

export const billingSubscriptionIntents = pgTable("billing_subscription_intents", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  subscriptionId: uuid("subscription_id").notNull().references(() => billingSubscriptions.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  action: text("action").notNull(),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_subscription_intents_user_idempotency_unique").on(table.userId, table.idempotencyKey),
  index("billing_subscription_intents_retry_idx").on(table.status, table.updatedAt),
  check("billing_subscription_intents_hash_check", sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`),
  check("billing_subscription_intents_action_check", sql`${table.action} IN ('cancel_at_period_end', 'resume')`),
  check("billing_subscription_intents_status_check", sql`${table.status} IN ('pending', 'provider_submitted', 'failed')`),
  check("billing_subscription_intents_attempts_check", sql`${table.attempts} BETWEEN 0 AND 20`),
]);

export const billingPayments = pgTable("billing_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").references(() => billingOrders.id, { onDelete: "restrict" }),
  subscriptionId: uuid("subscription_id").references(() => billingSubscriptions.id, { onDelete: "restrict" }),
  providerInvoiceId: varchar("provider_invoice_id", { length: 255 }).notNull(),
  providerInvoicePaymentId: varchar("provider_invoice_payment_id", { length: 255 }),
  providerPaymentId: varchar("provider_payment_id", { length: 255 }),
  providerChargeId: varchar("provider_charge_id", { length: 255 }),
  providerEventId: varchar("provider_event_id", { length: 255 }).notNull()
    .references(() => billingWebhookEvents.providerEventId, { onDelete: "restrict" }),
  amount: bigint("amount", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  paidAt: timestamptz("paid_at").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_payments_invoice_unique").on(table.providerInvoiceId),
  unique("billing_payments_invoice_payment_unique").on(table.providerInvoicePaymentId),
  index("billing_payments_provider_payment_idx").on(table.providerPaymentId),
  index("billing_payments_provider_charge_idx").on(table.providerChargeId),
  unique("billing_payments_event_unique").on(table.providerEventId),
  index("billing_payments_order_idx").on(table.orderId, table.createdAt),
  check("billing_payments_amount_check", sql`${table.amount} BETWEEN 0 AND 1000000000`),
  check("billing_payments_currency_check", currencyCheck(table.currency)),
]);

export const billingInvoicePaymentLinks = pgTable("billing_invoice_payment_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  paymentId: uuid("payment_id").notNull().references(() => billingPayments.id, { onDelete: "restrict" }),
  providerInvoicePaymentId: varchar("provider_invoice_payment_id", { length: 255 }).notNull(),
  providerPaymentId: varchar("provider_payment_id", { length: 255 }),
  providerChargeId: varchar("provider_charge_id", { length: 255 }),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_invoice_payment_links_provider_unique").on(table.providerInvoicePaymentId),
  index("billing_invoice_payment_links_payment_idx").on(table.paymentId, table.createdAt),
  index("billing_invoice_payment_links_provider_payment_idx").on(table.providerPaymentId),
  index("billing_invoice_payment_links_provider_charge_idx").on(table.providerChargeId),
  check("billing_invoice_payment_links_target_check",
    sql`${table.providerPaymentId} IS NOT NULL OR ${table.providerChargeId} IS NOT NULL`),
]);

export const billingRefunds = pgTable("billing_refunds", {
  id: uuid("id").defaultRandom().primaryKey(),
  paymentId: uuid("payment_id").notNull().references(() => billingPayments.id, { onDelete: "restrict" }),
  providerRefundId: varchar("provider_refund_id", { length: 255 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 255 }).notNull()
    .references(() => billingWebhookEvents.providerEventId, { onDelete: "restrict" }),
  amount: bigint("amount", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_refunds_provider_unique").on(table.providerRefundId),
  unique("billing_refunds_event_unique").on(table.providerEventId),
  index("billing_refunds_payment_idx").on(table.paymentId, table.createdAt),
  check("billing_refunds_amount_check", sql`${table.amount} BETWEEN 1 AND 1000000000`),
  check("billing_refunds_currency_check", currencyCheck(table.currency)),
]);

export const billingDisputes = pgTable("billing_disputes", {
  id: uuid("id").defaultRandom().primaryKey(),
  paymentId: uuid("payment_id").references(() => billingPayments.id, { onDelete: "restrict" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  providerDisputeId: varchar("provider_dispute_id", { length: 255 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 255 }).notNull()
    .references(() => billingWebhookEvents.providerEventId, { onDelete: "restrict" }),
  amount: bigint("amount", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: text("status").default("needs_review").notNull(),
  previousSubscriptionStatus: text("previous_subscription_status"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_disputes_provider_unique").on(table.providerDisputeId),
  unique("billing_disputes_event_unique").on(table.providerEventId),
  check("billing_disputes_amount_check", sql`${table.amount} BETWEEN 1 AND 1000000000`),
  check("billing_disputes_currency_check", currencyCheck(table.currency)),
  check("billing_disputes_status_check", sql`${table.status} IN ('needs_review', 'won', 'lost', 'closed')`),
]);

export const billingEntitlementOutbox = pgTable("billing_entitlement_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  subscriptionId: uuid("subscription_id").references(() => billingSubscriptions.id, { onDelete: "restrict" }),
  sourceEventId: varchar("source_event_id", { length: 255 }).notNull()
    .references(() => billingWebhookEvents.providerEventId, { onDelete: "restrict" }),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  leaseId: uuid("lease_id"),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  processedAt: timestamptz("processed_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_entitlement_outbox_source_unique").on(table.sourceEventId),
  index("billing_entitlement_outbox_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  check("billing_entitlement_outbox_status_check", sql`${table.status} IN ('pending', 'leased', 'done', 'failed')`),
  check("billing_entitlement_outbox_attempts_check", sql`${table.attempts} BETWEEN 0 AND 20`),
  check("billing_entitlement_outbox_lease_shape_check", sql`
    (${table.status} = 'leased' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'leased' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)
  `),
]);

export const billingReconciliationRuns = pgTable("billing_reconciliation_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  runKey: varchar("run_key", { length: 160 }).notNull(),
  status: text("status").default("running").notNull(),
  phase: text("phase").default("provider").notNull(),
  cursor: varchar("cursor", { length: 2048 }),
  providerPages: integer("provider_pages").default(0).notNull(),
  internalPages: integer("internal_pages").default(0).notNull(),
  comparePages: integer("compare_pages").default(0).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at").notNull(),
  nextAttemptAt: timestamptz("next_attempt_at"),
  errorCode: varchar("error_code", { length: 80 }),
  startedAt: timestamptz("started_at").defaultNow().notNull(),
  completedAt: timestamptz("completed_at"),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_reconciliation_runs_key_unique").on(table.runKey),
  index("billing_reconciliation_runs_claim_idx").on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
  check("billing_reconciliation_runs_status_check", sql`${table.status} IN ('running', 'retry', 'completed', 'failed')`),
  check("billing_reconciliation_runs_phase_check", sql`${table.phase} IN ('provider', 'internal', 'compare')`),
  check("billing_reconciliation_runs_attempts_check", sql`${table.attempts} BETWEEN 0 AND 20`),
  check("billing_reconciliation_runs_progress_check",
    sql`${table.providerPages} BETWEEN 0 AND 10000 AND ${table.internalPages} BETWEEN 0 AND 10000 AND ${table.comparePages} BETWEEN 0 AND 10000`),
]);

export const billingReconciliationCursors = pgTable("billing_reconciliation_cursors", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => billingReconciliationRuns.id, { onDelete: "restrict" }),
  phase: text("phase").notNull(),
  cursorHash: varchar("cursor_hash", { length: 64 }).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_reconciliation_cursors_dedupe_unique").on(table.runId, table.phase, table.cursorHash),
  index("billing_reconciliation_cursors_run_idx").on(table.runId, table.phase),
  check("billing_reconciliation_cursors_phase_check", sql`${table.phase} IN ('provider', 'internal', 'compare')`),
  check("billing_reconciliation_cursors_hash_check", sql`${table.cursorHash} ~ '^[a-f0-9]{64}$'`),
]);

export const billingReconciliationCollected = pgTable("billing_reconciliation_collected", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => billingReconciliationRuns.id, { onDelete: "restrict" }),
  side: text("side").notNull(),
  objectType: text("object_type").notNull(),
  providerObjectId: varchar("provider_object_id", { length: 255 }).notNull(),
  objectStatus: varchar("object_status", { length: 80 }),
  amount: bigint("amount", { mode: "number" }),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_reconciliation_collected_dedupe_unique")
    .on(table.runId, table.side, table.objectType, table.providerObjectId),
  index("billing_reconciliation_collected_run_idx").on(table.runId, table.side, table.objectType),
  check("billing_reconciliation_collected_side_check", sql`${table.side} IN ('provider', 'internal')`),
  check("billing_reconciliation_collected_type_check", sql`${table.objectType} IN ('subscriptions', 'invoices', 'refunds', 'disputes')`),
  check("billing_reconciliation_collected_amount_check", sql`${table.amount} IS NULL OR ${table.amount} BETWEEN 0 AND 1000000000`),
]);

export const billingReconciliationItems = pgTable("billing_reconciliation_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => billingReconciliationRuns.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  objectType: text("object_type").notNull(),
  providerObjectId: varchar("provider_object_id", { length: 255 }).notNull(),
  internalFingerprint: varchar("internal_fingerprint", { length: 64 }),
  providerFingerprint: varchar("provider_fingerprint", { length: 64 }),
  status: text("status").default("open").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("billing_reconciliation_items_dedupe_unique")
    .on(table.runId, table.kind, table.objectType, table.providerObjectId),
  index("billing_reconciliation_items_review_idx").on(table.status, table.createdAt),
  check("billing_reconciliation_items_kind_check", sql`${table.kind} IN ('missing_internal', 'missing_provider', 'value_mismatch')`),
  check("billing_reconciliation_items_type_check", sql`${table.objectType} IN ('subscriptions', 'invoices', 'refunds', 'disputes')`),
  check("billing_reconciliation_items_status_check", sql`${table.status} IN ('open', 'reviewing', 'resolved', 'dismissed')`),
]);
