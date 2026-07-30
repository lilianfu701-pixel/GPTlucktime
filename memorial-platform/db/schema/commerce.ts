import {
  bigint,
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { memorials } from "./memorial";

/**
 * Plans and entitlements, reserved but not sold.
 *
 * Phase one has no payment: doc 01 section 4.5 keeps a basic memorial and basic
 * commemorations free forever, and there is no route in this application that
 * creates a real order. The tables exist so that adding paid tiers later is a
 * matter of populating them rather than reshaping how every feature asks what a
 * family is allowed.
 *
 * Nothing here can withdraw a memorial. A page is not deleted for not paying.
 */

export const featureValueType = pgEnum("feature_value_type", [
  "integer",
  "boolean",
  "string",
]);

export const planStatus = pgEnum("plan_status", ["active", "retired"]);

export const subscriptionStatus = pgEnum("subscription_status", [
  "active",
  "past_due",
  "cancelled",
  "expired",
]);

/**
 * Order states exist so the shape is settled before money is involved.
 * No code path in phase one moves an order out of `draft`.
 */
export const orderStatus = pgEnum("order_status", [
  "draft",
  "pending",
  "paid",
  "refunded",
  "failed",
  "cancelled",
]);

/** A thing a plan can grant. The key is what feature code asks for. */
export const features = pgTable(
  "features",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    valueType: featureValueType("value_type").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("features_key_key").on(table.key)],
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    adminLabel: text("admin_label").notNull(),
    status: planStatus("status").default("active").notNull(),
    /** Exactly one plan applies to everyone with no subscription. */
    isDefault: boolean("is_default").default(false).notNull(),
    /** Minor units, so no rounding is invented later. Null while nothing is sold. */
    priceMinor: bigint("price_minor", { mode: "number" }),
    currency: text("currency"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("plans_slug_key").on(table.slug)],
);

export const planEntitlements = pgTable(
  "plan_entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    /** Stored as text and parsed by the feature's declared type. */
    value: text("value").notNull(),
  },
  (table) => [
    uniqueIndex("plan_entitlements_plan_feature_key").on(
      table.planId,
      table.featureId,
    ),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: subscriptionStatus("status").default("active").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** Who granted it, while the only way to get one is administratively. */
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("subscriptions_user_idx").on(table.userId, table.status)],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "restrict" }),
    status: orderStatus("status").default("draft").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("orders_user_idx").on(table.userId, table.status)],
);

/**
 * An entitlement granted to one memorial directly.
 *
 * Takes precedence over any plan. Its purpose is to let support give a family
 * more room without selling them anything: a memorial with more photographs
 * than the default allows should be an answerable request, not a purchase.
 */
export const memorialEntitlements = pgTable(
  "memorial_entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("memorial_entitlements_memorial_feature_key").on(
      table.memorialId,
      table.featureId,
    ),
  ],
);

export type Feature = typeof features.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type MemorialEntitlement = typeof memorialEntitlements.$inferSelect;
