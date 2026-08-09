import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./auth";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Task 13 must anonymize before account deletion; message authorship is retained, never cascaded.
  lowUserId: uuid("low_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  highUserId: uuid("high_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  status: text("status").default("active").notNull(),
  nextSequence: bigint("next_sequence", { mode: "number" }).default(1).notNull(),
  version: integer("version").default(1).notNull(),
  lastMessageAt: timestamptz("last_message_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("conversations_pair_unique").on(table.lowUserId, table.highUserId),
  unique("conversations_identity_pair_unique").on(table.id, table.lowUserId, table.highUserId),
  index("conversations_low_recent_idx").on(table.lowUserId, table.lastMessageAt, table.id),
  index("conversations_high_recent_idx").on(table.highUserId, table.lastMessageAt, table.id),
  check("conversations_ordered_pair_check", sql`${table.lowUserId} < ${table.highUserId}`),
  check("conversations_status_check", sql`${table.status} IN ('active', 'closed')`),
  check("conversations_next_sequence_check", sql`${table.nextSequence} BETWEEN 1 AND 9007199254740991`),
  check("conversations_version_check", sql`${table.version} > 0`),
]);

export const conversationMembers = pgTable("conversation_members", {
  conversationId: uuid("conversation_id").notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  lowUserId: uuid("low_user_id").notNull(),
  highUserId: uuid("high_user_id").notNull(),
  lastReadSequence: bigint("last_read_sequence", { mode: "number" }).default(0).notNull(),
  hiddenAt: timestamptz("hidden_at"),
  version: integer("version").default(1).notNull(),
  joinedAt: timestamptz("joined_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.userId], name: "conversation_members_pk" }),
  foreignKey({
    columns: [table.conversationId, table.lowUserId, table.highUserId],
    foreignColumns: [conversations.id, conversations.lowUserId, conversations.highUserId],
    name: "conversation_members_conversation_pair_fk",
  }).onDelete("cascade"),
  index("conversation_members_owner_recent_idx").on(table.userId, table.hiddenAt, table.conversationId),
  check("conversation_members_last_read_check", sql`${table.lastReadSequence} BETWEEN 0 AND 9007199254740991`),
  check("conversation_members_version_check", sql`${table.version} > 0`),
  check("conversation_members_user_in_pair_check", sql`${table.userId} IN (${table.lowUserId}, ${table.highUserId})`),
]);

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id").notNull()
    .references(() => conversations.id, { onDelete: "restrict" }),
  lowUserId: uuid("low_user_id").notNull(),
  highUserId: uuid("high_user_id").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  senderUserId: uuid("sender_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  clientId: uuid("client_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("messages_conversation_sequence_unique").on(table.conversationId, table.sequence),
  unique("messages_identity_conversation_unique").on(table.id, table.conversationId),
  // A client-generated id belongs to one immutable sender request across every conversation.
  unique("messages_sender_client_unique").on(table.senderUserId, table.clientId),
  index("messages_conversation_history_idx").on(table.conversationId, table.sequence),
  foreignKey({
    columns: [table.conversationId, table.lowUserId, table.highUserId],
    foreignColumns: [conversations.id, conversations.lowUserId, conversations.highUserId],
    name: "messages_conversation_pair_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.conversationId, table.senderUserId],
    foreignColumns: [conversationMembers.conversationId, conversationMembers.userId],
    name: "messages_sender_member_fk",
  }).onDelete("restrict"),
  check("messages_sequence_check", sql`${table.sequence} BETWEEN 1 AND 9007199254740991`),
  check("messages_body_length_check", sql`char_length(${table.body}) BETWEEN 1 AND 2000`),
  check("messages_sender_in_pair_check", sql`${table.senderUserId} IN (${table.lowUserId}, ${table.highUserId})`),
]);

export const messageOutboxEvents = pgTable("message_outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "restrict" }),
  eventType: text("event_type").default("message.created").notNull(),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
  payload: jsonb("payload").$type<{
    messageId: string;
    conversationId: string;
    senderUserId: string;
    sequence: number;
  }>().notNull(),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamptz("available_at").defaultNow().notNull(),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  publishedAt: timestamptz("published_at"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
}, (table) => [
  unique("message_outbox_message_unique").on(table.messageId),
  uniqueIndex("message_outbox_dedupe_unique").on(table.dedupeKey),
  index("message_outbox_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  check("message_outbox_type_check", sql`${table.eventType} = 'message.created'`),
  check("message_outbox_status_check", sql`${table.status} IN ('pending', 'processing', 'published', 'failed')`),
  check("message_outbox_attempts_check", sql`${table.attempts} >= 0`),
  check("message_outbox_lease_check", sql`
    (${table.status} = 'processing' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'processing' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)
  `),
  check("message_outbox_publish_check", sql`
    (${table.status} = 'published' AND ${table.publishedAt} IS NOT NULL)
    OR (${table.status} <> 'published' AND ${table.publishedAt} IS NULL)
  `),
]);

// Task 9 owns receipt mutation and visibility. This table only establishes the durable contract.
export const messageReceipts = pgTable("message_receipts", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  deliveredAt: timestamptz("delivered_at"),
  readAt: timestamptz("read_at"),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamptz("updated_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.messageId, table.userId], name: "message_receipts_pk" }),
  foreignKey({
    columns: [table.messageId, table.conversationId],
    foreignColumns: [messages.id, messages.conversationId],
    name: "message_receipts_message_conversation_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.conversationId, table.userId],
    foreignColumns: [conversationMembers.conversationId, conversationMembers.userId],
    name: "message_receipts_member_fk",
  }).onDelete("restrict"),
  index("message_receipts_user_read_idx").on(table.userId, table.readAt),
  check("message_receipts_order_check", sql`${table.readAt} IS NULL OR (${table.deliveredAt} IS NOT NULL AND ${table.readAt} >= ${table.deliveredAt})`),
  check("message_receipts_version_check", sql`${table.version} > 0`),
]);

// Attachments remain unavailable until Task 10's reviewed-media flow promotes them to approved.
export const messageAttachments = pgTable("message_attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  moderationStatus: text("moderation_status").default("pending_review").notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  reviewedAt: timestamptz("reviewed_at"),
}, (table) => [
  unique("message_attachments_object_key_unique").on(table.objectKey),
  index("message_attachments_review_idx").on(table.moderationStatus, table.createdAt),
  check("message_attachments_status_check", sql`${table.moderationStatus} IN ('pending_review', 'approved', 'rejected', 'quarantined')`),
]);
