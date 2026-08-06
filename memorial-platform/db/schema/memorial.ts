import {
  boolean,
  date,
  index,
  integer,
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
  /** Joined into another memorial. The row stays so its history survives. */
  "merged",
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
  "husband",
  "wife",
  "ex_husband",
  "ex_wife",
  "father",
  "mother",
  "son",
  "daughter",
  "older_sister",
  "older_brother",
  "younger_brother",
  "younger_sister",
]);

export const relationshipClaimStatus = pgEnum("relationship_claim_status", [
  "declared",
  "disputed",
  "verified",
  "rejected",
]);

export const relationshipCategory = pgEnum("relationship_category", [
  "spouse",
  "parent_child",
  "sibling",
  "grandparent_grandchild",
  "great_grandparent",
  "paternal_extended",
  "maternal_extended",
  "cousin",
  "nibling",
  "in_law_spouse_family",
  "in_law_sibling_child_spouse",
  "step_adoptive",
]);

/**
 * Reference table of all recognized family relationship types.
 *
 * 72 rows covering the full Chinese kinship terminology (中文亲属称谓),
 * with snake_case keys that map to locale-specific display names via i18n.
 * Each row carries its reverse so the system can derive B→A from A→B.
 */
export const relationshipTypes = pgTable("relationship_types", {
  key: text("key").primaryKey(),
  category: relationshipCategory("category").notNull(),
  gender: text("gender"),
  generationOffset: integer("generation_offset").notNull(),
  isBlood: boolean("is_blood").default(true).notNull(),
  isMarital: boolean("is_marital").default(false).notNull(),
  reverseKey: text("reverse_key"),
  displayOrder: integer("display_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

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
  ancestralHometown: text("ancestral_hometown"),
  faith: text("faith"),
  causeOfDeath: text("cause_of_death"),
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
    /** Set when this memorial was merged away, so its history stays traceable. */
    mergedIntoMemorialId: uuid("merged_into_memorial_id"),
    /**
     * Governance holds, set by a reviewer and cleared by one.
     *
     * Separate columns rather than one status, because they are independent: a
     * memorial can be frozen for an ownership dispute while the family carries
     * on editing it, and a page can have interactions closed without its
     * biography being locked.
     */
    ownershipFrozenAt: timestamp("ownership_frozen_at", { withTimezone: true }),
    editingRestrictedAt: timestamp("editing_restricted_at", {
      withTimezone: true,
    }),
    interactionsRestrictedAt: timestamp("interactions_restricted_at", {
      withTimezone: true,
    }),
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
 * The deceased person's relatives, shown on the memorial page.
 *
 * Living relatives are desensitized by default (name partially hidden) to
 * protect their privacy. The family can override this per relative.
 */
export const memorialRelatives = pgTable(
  "memorial_relatives",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    relationshipToDeceased: text("relationship_to_deceased").notNull(),
    isDeceased: boolean("is_deceased").default(false).notNull(),
    showFullName: boolean("show_full_name").default(false).notNull(),
    displayOrder: integer("display_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("memorial_relatives_memorial_idx").on(table.memorialId)],
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

export const recognitionClaimStatus = pgEnum("recognition_claim_status", [
  "pending",
  "escalated",
  "confirmed",
  "rejected",
  "withdrawn",
]);

/**
 * A registered user's claim that they are one of the relatives listed on a
 * memorial.
 *
 * This is distinct from `relationshipClaims`, which records the declaration the
 * *creator* made when setting up a memorial. A recognition claim flows in the
 * opposite direction: someone discovers they have been mentioned and asks to be
 * linked.
 *
 * The three-tier escalation protects both sides. The memorial owner is notified
 * immediately (tier 1). If they do not respond, reminders go out at day 7 and
 * day 14 (tier 2). After day 30 the claimant may request platform arbitration
 * (tier 3) — but auto-approval never happens, because a confirmed link grants
 * graph traversal rights.
 */
export const recognitionClaims = pgTable(
  "recognition_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    claimantUserId: uuid("claimant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    claimedName: text("claimed_name").notNull(),
    claimedRelationship: text("claimed_relationship").notNull(),
    status: recognitionClaimStatus("status").default("pending").notNull(),
    reminderCount: integer("reminder_count").default(0).notNull(),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("recognition_claims_memorial_idx").on(table.memorialId),
    index("recognition_claims_claimant_idx").on(table.claimantUserId),
    index("recognition_claims_status_idx").on(table.status),
  ],
);

export type RecognitionClaim = typeof recognitionClaims.$inferSelect;

export const exportJobStatus = pgEnum("export_job_status", [
  "requested",
  "building",
  "ready",
  "failed",
  "expired",
]);

/**
 * A family's request for a copy of their own memorial.
 *
 * The archive is built by a worker and reached through a short-lived signed
 * URL. It is never a permanent address: an export contains everything a family
 * wrote in one file, which is precisely the thing that should not sit behind a
 * link that keeps working after it has been forwarded.
 */
export const exportJobs = pgTable(
  "export_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: exportJobStatus("status").default("requested").notNull(),
    /** A retry with the same key returns the job already running. */
    idempotencyKey: text("idempotency_key").notNull(),
    objectKey: text("object_key"),
    /** Version of the manifest format, so an old archive stays readable. */
    manifestVersion: text("manifest_version"),
    failureReason: text("failure_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("export_jobs_memorial_idempotency_key").on(
      table.memorialId,
      table.idempotencyKey,
    ),
    index("export_jobs_status_idx").on(table.status),
  ],
);

export type ExportJob = typeof exportJobs.$inferSelect;
