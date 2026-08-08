import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { profiles } from "./profiles";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

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

export const savedSearches = pgTable("saved_searches", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
  schemaVersion: integer("schema_version").default(1).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("saved_searches_owner_created_idx").on(table.userId, table.createdAt),
  unique("saved_searches_owner_name_unique").on(table.userId, table.name),
]);

export const discoverySnapshots = pgTable("discovery_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  filterFingerprint: varchar("filter_fingerprint", { length: 64 }).notNull(),
  rankingVersion: varchar("ranking_version", { length: 50 }).notNull(),
  status: text("status").default("building").notNull(),
  buildLeaseId: uuid("build_lease_id"),
  buildLeaseExpiresAt: timestamptz("build_lease_expires_at"),
  itemCount: integer("item_count").notNull(),
  truncated: boolean("truncated").default(false).notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  index("discovery_snapshots_owner_expiry_idx").on(table.ownerUserId, table.expiresAt),
  index("discovery_snapshots_owner_created_idx").on(table.ownerUserId, table.createdAt),
  index("discovery_snapshots_build_lease_idx").on(table.status, table.buildLeaseExpiresAt),
  index("discovery_snapshots_expiry_idx").on(table.expiresAt),
  check("discovery_snapshots_status_check", sql`${table.status} IN ('building', 'ready')`),
]);

export const discoverySnapshotItems = pgTable("discovery_snapshot_items", {
  snapshotId: uuid("snapshot_id").notNull().references(() => discoverySnapshots.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  candidateUserId: uuid("candidate_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  candidateProfileId: uuid("candidate_profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  score: doublePrecision("score").notNull(),
  reasons: text("reasons").array().default(sql`'{}'::text[]`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.snapshotId, table.ordinal], name: "discovery_snapshot_items_pk" }),
  unique("discovery_snapshot_items_candidate_unique").on(table.snapshotId, table.candidateProfileId),
  index("discovery_snapshot_items_candidate_idx").on(table.candidateProfileId),
  check("discovery_snapshot_items_ordinal_check", sql`${table.ordinal} >= 0`),
]);
