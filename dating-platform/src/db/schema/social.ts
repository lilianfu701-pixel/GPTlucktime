import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

// This physical table was introduced by discovery. Social owns the single
// Drizzle definition now; discovery continues importing it through schema/index.
export const userBlocks = pgTable("user_blocks", {
  id: uuid("id").defaultRandom().primaryKey(),
  blockerUserId: uuid("blocker_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  blockedUserId: uuid("blocked_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reasonCode: text("reason_code"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("user_blocks_direction_unique").on(table.blockerUserId, table.blockedUserId),
  index("user_blocks_blocked_idx").on(table.blockedUserId, table.blockerUserId),
  check("user_blocks_not_self_check", sql`${table.blockerUserId} <> ${table.blockedUserId}`),
]);

export const socialLikes = pgTable("social_likes", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  revokedAt: timestamptz("revoked_at"),
}, (table) => [
  unique("social_likes_direction_unique").on(table.actorUserId, table.targetUserId),
  index("social_likes_received_idx").on(table.targetUserId, table.active, table.createdAt),
  index("social_likes_sent_idx").on(table.actorUserId, table.active, table.createdAt),
  check("social_likes_not_self_check", sql`${table.actorUserId} <> ${table.targetUserId}`),
]);

export const socialFavorites = pgTable("social_favorites", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("social_favorites_direction_unique").on(table.ownerUserId, table.targetUserId),
  index("social_favorites_owner_created_idx").on(table.ownerUserId, table.createdAt),
  check("social_favorites_not_self_check", sql`${table.ownerUserId} <> ${table.targetUserId}`),
]);

export const profileViews = pgTable("profile_views", {
  id: uuid("id").defaultRandom().primaryKey(),
  viewerUserId: uuid("viewer_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  viewedUserId: uuid("viewed_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  viewCount: integer("view_count").default(1).notNull(),
  firstViewedAt: timestamptz("first_viewed_at").defaultNow().notNull(),
  lastViewedAt: timestamptz("last_viewed_at").defaultNow().notNull(),
}, (table) => [
  unique("profile_views_direction_unique").on(table.viewerUserId, table.viewedUserId),
  index("profile_views_owner_recent_idx").on(table.viewedUserId, table.lastViewedAt),
  check("profile_views_not_self_check", sql`${table.viewerUserId} <> ${table.viewedUserId}`),
  check("profile_views_count_check", sql`${table.viewCount} > 0 AND ${table.viewCount} <= 2147483647`),
]);

export const socialMatches = pgTable("social_matches", {
  id: uuid("id").defaultRandom().primaryKey(),
  lowUserId: uuid("low_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  highUserId: uuid("high_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").default("active").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  hiddenAt: timestamptz("hidden_at"),
}, (table) => [
  unique("social_matches_pair_unique").on(table.lowUserId, table.highUserId),
  index("social_matches_low_status_idx").on(table.lowUserId, table.status, table.createdAt),
  index("social_matches_high_status_idx").on(table.highUserId, table.status, table.createdAt),
  check("social_matches_ordered_pair_check", sql`${table.lowUserId} < ${table.highUserId}`),
  check("social_matches_status_check", sql`${table.status} IN ('active', 'hidden', 'blocked')`),
]);

export const socialOutboxEvents = pgTable("social_outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventType: text("event_type").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  publishedAt: timestamptz("published_at"),
  suppressedAt: timestamptz("suppressed_at"),
  suppressionReason: text("suppression_reason"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("social_outbox_dedupe_unique").on(table.dedupeKey),
  index("social_outbox_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  check("social_outbox_event_type_check", sql`${table.eventType} IN ('match.created')`),
  check("social_outbox_status_check", sql`${table.status} IN ('pending', 'processing', 'published', 'failed', 'suppressed')`),
  check("social_outbox_attempts_check", sql`${table.attempts} >= 0`),
  check("social_outbox_lease_consistency_check", sql`
    (${table.status} = 'processing' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'processing' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)
  `),
  check("social_outbox_publish_consistency_check", sql`
    (${table.status} = 'published' AND ${table.publishedAt} IS NOT NULL)
    OR (${table.status} <> 'published' AND ${table.publishedAt} IS NULL)
  `),
  check("social_outbox_suppression_consistency_check", sql`
    (${table.status} = 'suppressed' AND ${table.suppressedAt} IS NOT NULL AND ${table.suppressionReason} IS NOT NULL)
    OR (${table.status} <> 'suppressed' AND ${table.suppressedAt} IS NULL AND ${table.suppressionReason} IS NULL)
  `),
]);

export const realtimePairRevocations = pgTable("realtime_pair_revocations", {
  id: uuid("id").defaultRandom().primaryKey(),
  lowUserId: uuid("low_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  highUserId: uuid("high_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  revokedBefore: timestamptz("revoked_before").notNull(),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("realtime_pair_revocations_pair_unique").on(table.lowUserId, table.highUserId),
  check("realtime_pair_revocations_ordered_pair_check", sql`${table.lowUserId} < ${table.highUserId}`),
  check("realtime_pair_revocations_version_check", sql`${table.version} > 0`),
]);

export const socialActionIdempotency = pgTable("social_action_idempotency", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  keyHash: varchar("key_hash", { length: 64 }).notNull(),
  action: text("action").notNull(),
  // Immutable request ledger: profile deletion must not erase replay/conflict history.
  targetProfileId: uuid("target_profile_id").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  // Keys remain non-reusable; Task 14 owns per-user limits and any tombstone compaction policy.
  unique("social_action_idempotency_actor_key_unique").on(table.actorUserId, table.keyHash),
  index("social_action_idempotency_owner_created_idx").on(table.actorUserId, table.createdAt),
  index("social_action_idempotency_created_idx").on(table.createdAt),
  check("social_action_idempotency_action_check", sql`${table.action} IN ('like', 'favorite', 'view', 'block')`),
]);
