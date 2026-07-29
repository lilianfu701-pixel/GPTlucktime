import {
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { datePrecision, memorials } from "./memorial";

export const contentType = pgEnum("content_type", [
  "biography",
  "timeline_event",
  "tribute",
]);

export const contentStatus = pgEnum("content_status", [
  "draft",
  "pending_review",
  "published",
  "rejected",
  "hidden",
]);

export const translationMethod = pgEnum("translation_method", [
  "human",
  "machine",
]);

export const translationStatus = pgEnum("translation_status", [
  "draft",
  "in_review",
  "published",
  "retired",
]);

export const submissionKind = pgEnum("submission_kind", ["story", "photo"]);

/**
 * The immutable record of what was written, and by whom.
 *
 * Rows here are never updated. An edit appends a new version and moves the
 * pointer on the owning item. A family's account of a life is exactly the kind
 * of record where "who changed this, and what did it say before" has to be
 * answerable years later, including during an ownership dispute.
 */
export const contentVersions = pgTable(
  "content_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentType: contentType("content_type").notNull(),
    contentId: uuid("content_id").notNull(),
    version: integer("version").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    /** The language it was written in. Never rewritten by a translation. */
    sourceLocale: text("source_locale").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("content_versions_item_version_key").on(
      table.contentType,
      table.contentId,
      table.version,
    ),
    index("content_versions_item_idx").on(table.contentType, table.contentId),
  ],
);

/**
 * A translation of one version into one language.
 *
 * Attached to a version rather than to the item, so a translation can never be
 * mistaken for the original and never survives silently onto text it was not
 * made from. A machine translation is labelled as such and may not reach
 * `published` without a named reviewer. See doc 03 section 4.
 */
export const contentTranslations = pgTable(
  "content_translations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentVersionId: uuid("content_version_id")
      .notNull()
      .references(() => contentVersions.id, { onDelete: "cascade" }),
    targetLocale: text("target_locale").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    method: translationMethod("method").notNull(),
    status: translationStatus("status").default("draft").notNull(),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("content_translations_version_locale_key").on(
      table.contentVersionId,
      table.targetLocale,
    ),
  ],
);

/** One life story per memorial. */
export const biographies = pgTable(
  "biographies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    status: contentStatus("status").default("draft").notNull(),
    /** The version the public sees. Null until the family publishes one. */
    publishedVersionId: uuid("published_version_id").references(
      () => contentVersions.id,
      { onDelete: "set null" },
    ),
    latestVersion: integer("latest_version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("biographies_memorial_key").on(table.memorialId)],
);

export const timelineEvents = pgTable(
  "timeline_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    occurredOn: date("occurred_on", { mode: "string" }),
    occurredPrecision: datePrecision("occurred_precision")
      .default("unknown")
      .notNull(),
    status: contentStatus("status").default("draft").notNull(),
    publishedVersionId: uuid("published_version_id").references(
      () => contentVersions.id,
      { onDelete: "set null" },
    ),
    latestVersion: integer("latest_version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("timeline_events_memorial_idx").on(table.memorialId, table.occurredOn),
  ],
);

/** A longer written remembrance, by the family or by an approved visitor. */
export const tributes = pgTable(
  "tributes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: contentStatus("status").default("draft").notNull(),
    publishedVersionId: uuid("published_version_id").references(
      () => contentVersions.id,
      { onDelete: "set null" },
    ),
    latestVersion: integer("latest_version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [index("tributes_memorial_idx").on(table.memorialId, table.status)],
);

/**
 * Something a visitor offered: a story, or a photograph.
 *
 * Held apart from family content until someone with the authority to moderate
 * accepts it. A rejected submission stays for the audit trail and must never
 * appear in a public query.
 */
export const visitorSubmissions = pgTable(
  "visitor_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    submitterUserId: uuid("submitter_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: submissionKind("kind").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    sourceLocale: text("source_locale").notNull(),
    status: contentStatus("status").default("pending_review").notNull(),
    moderatedByUserId: uuid("moderated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    /** Kept for the family's record; never shown to the submitter verbatim. */
    moderationNote: text("moderation_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("visitor_submissions_memorial_idx").on(
      table.memorialId,
      table.status,
    ),
  ],
);

export type ContentVersion = typeof contentVersions.$inferSelect;
export type ContentTranslation = typeof contentTranslations.$inferSelect;
export type Biography = typeof biographies.$inferSelect;
export type VisitorSubmission = typeof visitorSubmissions.$inferSelect;
