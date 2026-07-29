import {
  boolean,
  date,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

export const datePrecision = pgEnum("date_precision", [
  "day",
  "month",
  "year",
  "approximate",
  "unknown",
]);

export const memorialStatus = pgEnum("memorial_status", [
  "draft",
  "published",
  "restricted",
  "hidden",
  "pending_deletion",
]);

export const memorialVisibility = pgEnum("memorial_visibility", [
  "public",
  "unlisted",
  "invite_only",
]);

export const memorialMemberRole = pgEnum("memorial_member_role", [
  "owner",
  "admin",
  "editor",
  "reviewer",
  "invited_visitor",
]);

export const memorialNameType = pgEnum("memorial_name_type", [
  "primary",
  "former",
  "native",
  "transliteration",
  "alias",
]);

export const memorialLocationKind = pgEnum("memorial_location_kind", [
  "birth",
  "death",
  "lived",
  "resting_place",
]);

export const relationshipKind = pgEnum("relationship_kind", [
  "spouse",
  "parent",
  "child",
  "sibling",
]);

export const relationshipClaimStatus = pgEnum("relationship_claim_status", [
  "declared",
  "disputed",
  "verified",
  "rejected",
]);

/**
 * The person being remembered, kept apart from the page about them.
 *
 * A duplicate merge joins two pages that describe one person; separating the
 * subject from the page is what makes that possible without rewriting history.
 *
 * Dates are stored as a date plus a precision. When precision is coarser than
 * `day`, the unknown components are the first of the period: `year` for 1948 is
 * stored as 1948-01-01. Readers must consult the precision before displaying a
 * date, and must never present a placeholder component as fact.
 */
export const deceasedPeople = pgTable("deceased_people", {
  id: uuid("id").defaultRandom().primaryKey(),
  birthDate: date("birth_date", { mode: "string" }),
  birthDatePrecision: datePrecision("birth_date_precision")
    .default("unknown")
    .notNull(),
  deathDate: date("death_date", { mode: "string" }),
  deathDatePrecision: datePrecision("death_date_precision")
    .default("unknown")
    .notNull(),
  /** Optional by design: doc 06 section 5 requires data minimization. */
  gender: text("gender"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const memorials = pgTable(
  "memorials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deceasedPersonId: uuid("deceased_person_id")
      .notNull()
      .references(() => deceasedPeople.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    status: memorialStatus("status").default("draft").notNull(),
    /** A new memorial is public and searchable unless the family says otherwise. */
    visibility: memorialVisibility("visibility").default("public").notNull(),
    searchEngineIndexable: boolean("search_engine_indexable")
      .default(true)
      .notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /**
     * The key the creator's client sent. Enforced by a unique index rather than
     * a read-then-write check, so a retry that arrives while the first request
     * is still in flight cannot produce a second memorial for one death.
     */
    creationIdempotencyKey: text("creation_idempotency_key"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true,
    }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("memorials_slug_key").on(table.slug),
    uniqueIndex("memorials_owner_idempotency_key").on(
      table.ownerUserId,
      table.creationIdempotencyKey,
    ),
    index("memorials_owner_idx").on(table.ownerUserId),
    index("memorials_visibility_idx").on(table.visibility, table.status),
    index("memorials_purge_idx").on(table.purgeAfter),
  ],
);

/**
 * Names are rows, not columns.
 *
 * Not every name divides into given and family parts, people are known by
 * different names in different scripts, and a family may want a former name
 * recorded but not searchable. See doc 07 section 4.
 */
export const memorialNames = pgTable(
  "memorial_names",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    locale: text("locale"),
    /** ISO 15924, e.g. Hans, Hant, Latn, Arab. */
    script: text("script"),
    type: memorialNameType("type").default("primary").notNull(),
    /** The family may record a name without letting it be searched. */
    searchable: boolean("searchable").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("memorial_names_memorial_idx").on(table.memorialId),
    index("memorial_names_value_idx").on(table.value),
  ],
);

export const memorialLocations = pgTable(
  "memorial_locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    kind: memorialLocationKind("kind").notNull(),
    /** ISO 3166-1 alpha-2. */
    country: text("country"),
    region: text("region"),
    city: text("city"),
  },
  (table) => [index("memorial_locations_memorial_idx").on(table.memorialId)],
);

/**
 * Family membership.
 *
 * A revoked row is kept rather than deleted, so a later dispute can show who
 * had access and when.
 */
export const memorialMembers = pgTable(
  "memorial_members",
  {
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memorialMemberRole("role").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memorialId, table.userId] }),
    index("memorial_members_user_idx").on(table.userId),
  ],
);

/**
 * The relationship the creator declared, and the promise they accepted.
 *
 * `statementVersion` records which wording they agreed to, so a later dispute
 * is judged against the text that was actually shown.
 */
export const relationshipClaims = pgTable(
  "relationship_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    claimantUserId: uuid("claimant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    relationship: relationshipKind("relationship").notNull(),
    statementVersion: text("statement_version").notNull(),
    status: relationshipClaimStatus("status").default("declared").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("relationship_claims_memorial_idx").on(table.memorialId),
    index("relationship_claims_claimant_idx").on(table.claimantUserId),
  ],
);

/**
 * An outstanding invitation to help manage a memorial.
 *
 * Only the hash of the token is stored, as with session tokens: a copy of this
 * table must not be usable to walk into a family's private memorial.
 *
 * `owner` is absent from the invitable roles on purpose. Ownership moves
 * through an explicit transfer that the current owner performs, not by handing
 * out a link.
 */
export const memorialInvitations = pgTable(
  "memorial_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    /** Normalized address the invitation was sent to. */
    email: text("email").notNull(),
    role: memorialMemberRole("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("memorial_invitations_token_key").on(table.tokenHash),
    index("memorial_invitations_memorial_idx").on(table.memorialId),
    index("memorial_invitations_email_idx").on(table.email),
  ],
);

export type Memorial = typeof memorials.$inferSelect;
export type MemorialInvitation = typeof memorialInvitations.$inferSelect;
export type NewMemorial = typeof memorials.$inferInsert;
export type MemorialMember = typeof memorialMembers.$inferSelect;
export type RelationshipClaim = typeof relationshipClaims.$inferSelect;
