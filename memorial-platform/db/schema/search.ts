import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { memorials } from "./memorial";

/**
 * A denormalized copy of what a memorial can be found by.
 *
 * Deliberately does not carry the visibility. Every query joins `memorials` and
 * filters on the live row, so a document the worker has not cleaned up yet
 * cannot surface a memorial that has just been made private. Storing visibility
 * here would invite exactly that: a filter on a stale copy that looks correct.
 */
export const searchDocuments = pgTable(
  "search_documents",
  {
    memorialId: uuid("memorial_id")
      .primaryKey()
      .references(() => memorials.id, { onDelete: "cascade" }),
    /** Lowercased, accent-stripped, whitespace-collapsed names. */
    normalizedText: text("normalized_text").notNull(),
    /** Only names the family left searchable. */
    aliases: text("aliases").array(),
    countryCodes: text("country_codes").array(),
    placeTokens: text("place_tokens").array(),
    birthYear: integer("birth_year"),
    deathYear: integer("death_year"),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("search_documents_birth_year_idx").on(table.birthYear),
    index("search_documents_death_year_idx").on(table.deathYear),
  ],
);

export const duplicateStatus = pgEnum("duplicate_status", [
  "open",
  "dismissed",
  "merged",
]);

/**
 * Two memorials that may describe the same person.
 *
 * Recorded, never acted on. Doc 03 section 7 forbids automatic merging: joining
 * two families' pages is irreversible in the ways that matter, and a score is
 * not evidence. The component scores are stored so a reviewer can see what the
 * match was actually based on rather than trusting a single number.
 */
export const duplicateCandidates = pgTable(
  "duplicate_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    candidateMemorialId: uuid("candidate_memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
    componentScores: jsonb("component_scores").notNull(),
    status: duplicateStatus("status").default("open").notNull(),
    reviewedByUserId: uuid("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("duplicate_candidates_pair_key").on(
      table.memorialId,
      table.candidateMemorialId,
    ),
    index("duplicate_candidates_status_idx").on(table.status),
  ],
);

export type SearchDocument = typeof searchDocuments.$inferSelect;
export type DuplicateCandidate = typeof duplicateCandidates.$inferSelect;
