import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./auth";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const entitlementDefinitions = pgTable("entitlement_definitions", {
  key: varchar("key", { length: 80 }).primaryKey(),
  kind: text("kind").notNull(),
  resetPeriod: text("reset_period").default("none").notNull(),
  publicVisible: boolean("public_visible").default(true).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("entitlement_definitions_key_kind_unique").on(table.key, table.kind),
  check("entitlement_definitions_kind_check", sql`${table.kind} IN ('boolean', 'quota', 'numeric')`),
  check("entitlement_definitions_period_check", sql`${table.resetPeriod} IN ('none', 'daily', 'monthly')`),
  check("entitlement_definitions_period_kind_check", sql`
    (${table.kind} = 'quota' AND ${table.resetPeriod} IN ('daily', 'monthly'))
    OR (${table.kind} <> 'quota' AND ${table.resetPeriod} = 'none')
  `),
]);

export const entitlementConfigurations = pgTable("entitlement_configurations", {
  id: uuid("id").defaultRandom().primaryKey(),
  entitlementKey: varchar("entitlement_key", { length: 80 }).notNull()
    .references(() => entitlementDefinitions.key, { onDelete: "restrict" }),
  scope: text("scope").notNull(),
  version: integer("version").notNull(),
  kind: text("kind").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  booleanValue: boolean("boolean_value"),
  quotaLimit: integer("quota_limit"),
  numericValue: numeric("numeric_value", { precision: 12, scale: 4, mode: "number" }),
  upgradeHint: varchar("upgrade_hint", { length: 80 }),
  effectiveAt: timestamptz("effective_at").notNull(),
  expiresAt: timestamptz("expires_at"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("entitlement_configurations_key_scope_version_unique")
    .on(table.entitlementKey, table.scope, table.version),
  foreignKey({
    columns: [table.entitlementKey, table.kind],
    foreignColumns: [entitlementDefinitions.key, entitlementDefinitions.kind],
    name: "entitlement_configurations_key_kind_fk",
  }).onDelete("restrict"),
  index("entitlement_configurations_resolution_idx")
    .on(table.entitlementKey, table.scope, table.active, table.effectiveAt, table.expiresAt, table.version),
  check("entitlement_configurations_scope_check", sql`${table.scope} IN ('global_flag', 'free_default')`),
  check("entitlement_configurations_version_check", sql`${table.version} > 0`),
  check("entitlement_configurations_kind_check", sql`${table.kind} IN ('boolean', 'quota', 'numeric')`),
  check("entitlement_configurations_quota_check", sql`${table.quotaLimit} IS NULL OR ${table.quotaLimit} BETWEEN 0 AND 1000000`),
  check("entitlement_configurations_numeric_check", sql`${table.numericValue} IS NULL OR ${table.numericValue} BETWEEN 0 AND 1000000`),
  check("entitlement_configurations_upgrade_hint_check", sql`${table.upgradeHint} IS NULL OR ${table.upgradeHint} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`),
  check("entitlement_configurations_window_check", sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.effectiveAt}`),
  check("entitlement_configurations_value_shape_check", sql`
    (${table.scope} = 'global_flag' AND ${table.booleanValue} IS NULL AND ${table.quotaLimit} IS NULL AND ${table.numericValue} IS NULL AND ${table.upgradeHint} IS NULL)
    OR (${table.scope} = 'free_default' AND (
      (${table.kind} = 'boolean' AND ${table.booleanValue} IS NOT NULL AND ${table.quotaLimit} IS NULL AND ${table.numericValue} IS NULL)
      OR (${table.kind} = 'quota' AND ${table.booleanValue} IS NULL AND ${table.numericValue} IS NULL)
      OR (${table.kind} = 'numeric' AND ${table.booleanValue} IS NULL AND ${table.quotaLimit} IS NULL AND ${table.numericValue} IS NOT NULL)
    ))
  `),
]);

export const entitlementUserOverrides = pgTable("entitlement_user_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  entitlementKey: varchar("entitlement_key", { length: 80 }).notNull()
    .references(() => entitlementDefinitions.key, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  kind: text("kind").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  booleanValue: boolean("boolean_value"),
  quotaLimit: integer("quota_limit"),
  numericValue: numeric("numeric_value", { precision: 12, scale: 4, mode: "number" }),
  upgradeHint: varchar("upgrade_hint", { length: 80 }),
  effectiveAt: timestamptz("effective_at").notNull(),
  expiresAt: timestamptz("expires_at"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("entitlement_user_overrides_user_key_version_unique")
    .on(table.userId, table.entitlementKey, table.version),
  foreignKey({
    columns: [table.entitlementKey, table.kind],
    foreignColumns: [entitlementDefinitions.key, entitlementDefinitions.kind],
    name: "entitlement_user_overrides_key_kind_fk",
  }).onDelete("restrict"),
  index("entitlement_user_overrides_resolution_idx")
    .on(table.userId, table.entitlementKey, table.active, table.effectiveAt, table.expiresAt, table.version),
  check("entitlement_user_overrides_version_check", sql`${table.version} > 0`),
  check("entitlement_user_overrides_kind_check", sql`${table.kind} IN ('boolean', 'quota', 'numeric')`),
  check("entitlement_user_overrides_quota_check", sql`${table.quotaLimit} IS NULL OR ${table.quotaLimit} BETWEEN 0 AND 1000000`),
  check("entitlement_user_overrides_numeric_check", sql`${table.numericValue} IS NULL OR ${table.numericValue} BETWEEN 0 AND 1000000`),
  check("entitlement_user_overrides_upgrade_hint_check", sql`${table.upgradeHint} IS NULL OR ${table.upgradeHint} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`),
  check("entitlement_user_overrides_window_check", sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.effectiveAt}`),
  check("entitlement_user_overrides_value_shape_check", sql`
    (${table.kind} = 'boolean' AND ${table.booleanValue} IS NOT NULL AND ${table.quotaLimit} IS NULL AND ${table.numericValue} IS NULL)
    OR (${table.kind} = 'quota' AND ${table.booleanValue} IS NULL AND ${table.numericValue} IS NULL)
    OR (${table.kind} = 'numeric' AND ${table.booleanValue} IS NULL AND ${table.quotaLimit} IS NULL AND ${table.numericValue} IS NOT NULL)
  `),
]);

// planRef is deliberately not a foreign key. Task 11 can attach billing plans
// without coupling entitlement history to mutable commercial records.
export const entitlementPlanBenefits = pgTable("entitlement_plan_benefits", {
  id: uuid("id").defaultRandom().primaryKey(),
  planRef: varchar("plan_ref", { length: 80 }).notNull(),
  entitlementKey: varchar("entitlement_key", { length: 80 }).notNull()
    .references(() => entitlementDefinitions.key, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  kind: text("kind").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  booleanValue: boolean("boolean_value"),
  quotaLimit: integer("quota_limit"),
  numericValue: numeric("numeric_value", { precision: 12, scale: 4, mode: "number" }),
  upgradeHint: varchar("upgrade_hint", { length: 80 }),
  effectiveAt: timestamptz("effective_at").notNull(),
  expiresAt: timestamptz("expires_at"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("entitlement_plan_benefits_plan_key_version_unique")
    .on(table.planRef, table.entitlementKey, table.version),
  foreignKey({
    columns: [table.entitlementKey, table.kind],
    foreignColumns: [entitlementDefinitions.key, entitlementDefinitions.kind],
    name: "entitlement_plan_benefits_key_kind_fk",
  }).onDelete("restrict"),
  index("entitlement_plan_benefits_resolution_idx")
    .on(table.planRef, table.entitlementKey, table.active, table.effectiveAt, table.expiresAt, table.version),
  check("entitlement_plan_benefits_plan_ref_check", sql`length(${table.planRef}) BETWEEN 1 AND 80`),
  check("entitlement_plan_benefits_version_check", sql`${table.version} > 0`),
  check("entitlement_plan_benefits_kind_check", sql`${table.kind} IN ('boolean', 'quota', 'numeric')`),
  check("entitlement_plan_benefits_quota_check", sql`${table.quotaLimit} IS NULL OR ${table.quotaLimit} BETWEEN 0 AND 1000000`),
  check("entitlement_plan_benefits_numeric_check", sql`${table.numericValue} IS NULL OR ${table.numericValue} BETWEEN 0 AND 1000000`),
  check("entitlement_plan_benefits_upgrade_hint_check", sql`${table.upgradeHint} IS NULL OR ${table.upgradeHint} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`),
  check("entitlement_plan_benefits_window_check", sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.effectiveAt}`),
  check("entitlement_plan_benefits_value_shape_check", sql`
    (${table.kind} = 'boolean' AND ${table.booleanValue} IS NOT NULL AND ${table.quotaLimit} IS NULL AND ${table.numericValue} IS NULL)
    OR (${table.kind} = 'quota' AND ${table.booleanValue} IS NULL AND ${table.numericValue} IS NULL)
    OR (${table.kind} = 'numeric' AND ${table.booleanValue} IS NULL AND ${table.quotaLimit} IS NULL AND ${table.numericValue} IS NOT NULL)
  `),
]);

export const entitlementUsageCounters = pgTable("entitlement_usage_counters", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  entitlementKey: varchar("entitlement_key", { length: 80 }).notNull()
    .references(() => entitlementDefinitions.key, { onDelete: "restrict" }),
  periodStart: timestamptz("period_start").notNull(),
  resetAt: timestamptz("reset_at").notNull(),
  used: integer("used").default(0).notNull(),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.entitlementKey, table.periodStart], name: "entitlement_usage_counters_pk" }),
  index("entitlement_usage_counters_reset_idx").on(table.resetAt),
  check("entitlement_usage_counters_used_check", sql`${table.used} BETWEEN 0 AND 1000000`),
  check("entitlement_usage_counters_version_check", sql`${table.version} > 0`),
  check("entitlement_usage_counters_window_check", sql`${table.resetAt} > ${table.periodStart}`),
]);

export const entitlementUsageOperations = pgTable("entitlement_usage_operations", {
  operationId: uuid("operation_id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  entitlementKey: varchar("entitlement_key", { length: 80 }).notNull()
    .references(() => entitlementDefinitions.key, { onDelete: "restrict" }),
  contextHash: varchar("context_hash", { length: 64 }).notNull(),
  amount: integer("amount").notNull(),
  kind: text("kind").notNull(),
  allowed: boolean("allowed").notNull(),
  value: numeric("value", { precision: 12, scale: 4, mode: "number" }),
  limit: integer("limit"),
  remaining: integer("remaining"),
  resetAt: timestamptz("reset_at"),
  reason: text("reason"),
  upgradeHint: varchar("upgrade_hint", { length: 80 }),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  index("entitlement_usage_operations_owner_created_idx").on(table.userId, table.createdAt),
  index("entitlement_usage_operations_retention_idx").on(table.createdAt),
  check("entitlement_usage_operations_amount_check", sql`${table.amount} BETWEEN 1 AND 1000000`),
  check("entitlement_usage_operations_kind_check", sql`${table.kind} IN ('boolean', 'quota', 'numeric')`),
  check("entitlement_usage_operations_value_check", sql`${table.value} IS NULL OR ${table.value} BETWEEN 0 AND 1000000`),
  check("entitlement_usage_operations_limit_check", sql`${table.limit} IS NULL OR ${table.limit} BETWEEN 0 AND 1000000`),
  check("entitlement_usage_operations_remaining_check", sql`${table.remaining} IS NULL OR ${table.remaining} BETWEEN 0 AND 1000000`),
  check("entitlement_usage_operations_upgrade_hint_check", sql`${table.upgradeHint} IS NULL OR ${table.upgradeHint} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`),
  check("entitlement_usage_operations_reason_check", sql`${table.reason} IS NULL OR ${table.reason} IN ('SAFETY_RESTRICTED', 'VERIFICATION_REQUIRED', 'FEATURE_DISABLED', 'NOT_INCLUDED', 'LIMIT_REACHED', 'CONFIGURATION_INVALID')`),
]);

export const entitlementUserPlanAssignments = pgTable("entitlement_user_plan_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  planRef: varchar("plan_ref", { length: 80 }).notNull(),
  version: integer("version").notNull(),
  active: boolean("active").default(true).notNull(),
  effectiveAt: timestamptz("effective_at").notNull(),
  expiresAt: timestamptz("expires_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("entitlement_user_plan_assignments_user_version_unique").on(table.userId, table.version),
  index("entitlement_user_plan_assignments_resolution_idx")
    .on(table.userId, table.active, table.effectiveAt, table.expiresAt, table.version),
  check("entitlement_user_plan_assignments_plan_ref_check", sql`${table.planRef} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`),
  check("entitlement_user_plan_assignments_version_check", sql`${table.version} > 0`),
  check("entitlement_user_plan_assignments_window_check", sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.effectiveAt}`),
]);
