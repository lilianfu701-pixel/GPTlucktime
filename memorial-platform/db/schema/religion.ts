import {
  boolean,
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

/**
 * The religion and culture catalog.
 *
 * A classification row is a catalogue entry, not a statement of doctrine. The
 * platform records that a tradition exists and what a reviewed source says
 * about a practice; it does not decide what a faith teaches.
 *
 * See docs/memorial-platform/05-religion-culture-engine.md.
 */

export const catalogLifecycle = pgEnum("catalog_lifecycle", [
  "draft",
  "in_review",
  "published",
  "retired",
]);

export const ritualActionType = pgEnum("ritual_action_type", [
  "offering",
  "light",
  "prayer",
  "recitation",
  "gesture",
  "message",
  "contribution",
  "planting",
  "observance",
  "custom",
]);

/**
 * How well a ritual fits a set of circumstances.
 *
 * `recommended` and `optional` may be suggested to a family. Nothing is ever
 * enabled by the platform: doc 05 section 4 requires the family to turn each
 * one on themselves.
 */
export const compatibilityLevel = pgEnum("compatibility_level", [
  "recommended",
  "optional",
  "needs_family_confirmation",
  "not_recommended",
  "prohibited_combination",
]);

export const sourceKind = pgEnum("ritual_source_kind", [
  "scripture",
  "scholarly",
  "institutional",
  "ethnographic",
  "community_adviser",
]);

export const religions = pgTable(
  "religions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    /**
     * A neutral working label, in English, for administrators.
     * The reader-facing name comes from a reviewed translation, never from here.
     */
    adminLabel: text("admin_label").notNull(),
    status: catalogLifecycle("status").default("published").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("religions_slug_key").on(table.slug)],
);

/**
 * A denomination or school within a religion.
 *
 * Modelled separately because practice varies more between denominations than
 * the top-level classification suggests, and describing one denomination's
 * custom as the whole religion's rule is the failure doc 05 section 1 forbids.
 */
export const denominations = pgTable(
  "denominations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    religionId: uuid("religion_id")
      .notNull()
      .references(() => religions.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    adminLabel: text("admin_label").notNull(),
    status: catalogLifecycle("status").default("published").notNull(),
  },
  (table) => [uniqueIndex("denominations_slug_key").on(table.slug)],
);

/** An ethnic or regional tradition, independent of religion. */
export const culturalTraditions = pgTable(
  "cultural_traditions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    adminLabel: text("admin_label").notNull(),
    /** ISO 3166-1 alpha-2 hints. Not a claim that the tradition is confined there. */
    regionHints: text("region_hints").array(),
    status: catalogLifecycle("status").default("published").notNull(),
  },
  (table) => [uniqueIndex("cultural_traditions_slug_key").on(table.slug)],
);

/** The stable identity of a way of remembering. Its content lives in versions. */
export const ritualDefinitions = pgTable(
  "ritual_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    actionType: ritualActionType("action_type").notNull(),
    adminLabel: text("admin_label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("ritual_definitions_slug_key").on(table.slug)],
);

/**
 * One immutable revision of a ritual.
 *
 * Published rows are never edited. A correction creates a new version, so a
 * memorial that recorded the family's agreement to a specific version keeps
 * showing what they agreed to, and a later change to the catalogue cannot alter
 * a family's page without them being asked again. Doc 05 sections 3 and 5.
 */
export const ritualVersions = pgTable(
  "ritual_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => ritualDefinitions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: catalogLifecycle("status").default("draft").notNull(),

    /** Whom this revision speaks for. Publication requires at least one. */
    appliesToReligionId: uuid("applies_to_religion_id").references(
      () => religions.id,
      { onDelete: "restrict" },
    ),
    appliesToDenominationId: uuid("applies_to_denomination_id").references(
      () => denominations.id,
      { onDelete: "restrict" },
    ),
    appliesToCultureId: uuid("applies_to_culture_id").references(
      () => culturalTraditions.id,
      { onDelete: "restrict" },
    ),
    /** ISO 3166-1 alpha-2 codes this revision was reviewed for. */
    appliesToCountries: text("applies_to_countries").array(),
    /** Stated plainly, so a reader knows where this does not apply. */
    outOfScopeNote: text("out_of_scope_note"),

    allowAnonymous: boolean("allow_anonymous").default(false).notNull(),
    allowMessage: boolean("allow_message").default(true).notNull(),
    suggestPreReview: boolean("suggest_pre_review").default(true).notNull(),

    /** Identifier of a calendar adapter, when an anniversary follows one. */
    calendarId: text("calendar_id"),
    anniversaryRule: text("anniversary_rule"),

    /** Free-form tags used to detect conflicting combinations. */
    conflictTags: text("conflict_tags").array(),

    /**
     * Author and reviewer are recorded separately. Whether they must be
     * different people is a policy decision open in doc 11 section 4; the
     * columns exist so the answer can be enforced without a migration.
     */
    authoredByUserId: uuid("authored_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /** Why it was withdrawn. Shown to owners who had adopted it. */
    retirementReason: text("retirement_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("ritual_versions_definition_version_key").on(
      table.definitionId,
      table.version,
    ),
    index("ritual_versions_status_idx").on(table.status),
  ],
);

/**
 * Where a revision's claim comes from.
 *
 * Publication requires at least one. A rule with no source is an assertion by
 * the platform about someone's faith, which doc 05 section 6 forbids.
 */
export const ritualSources = pgTable(
  "ritual_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ritualVersionId: uuid("ritual_version_id")
      .notNull()
      .references(() => ritualVersions.id, { onDelete: "cascade" }),
    kind: sourceKind("kind").notNull(),
    citation: text("citation").notNull(),
    url: text("url"),
    /** Named adviser, where a person rather than a document is the source. */
    adviserName: text("adviser_name"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
  },
  (table) => [index("ritual_sources_version_idx").on(table.ritualVersionId)],
);

/**
 * The reader-facing name and explanation, per language.
 *
 * A machine translation may exist as a draft but cannot be the published
 * rendering: doc 05 section 7 and doc 07 section 3 both require a person to take
 * responsibility for religious wording.
 */
export const ritualTranslations = pgTable(
  "ritual_translations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ritualVersionId: uuid("ritual_version_id")
      .notNull()
      .references(() => ritualVersions.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    /** Terms whose translation is contested, noted rather than smoothed over. */
    terminologyNote: text("terminology_note"),
    method: text("method").notNull(),
    status: catalogLifecycle("status").default("draft").notNull(),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("ritual_translations_version_locale_key").on(
      table.ritualVersionId,
      table.locale,
    ),
  ],
);

/**
 * How a revision fits a religion, denomination, culture or country.
 *
 * When several rules match, the most restrictive wins. When none matches, the
 * engine offers nothing rather than guessing. Doc 05 section 4.
 */
export const ritualCompatibilityRules = pgTable(
  "ritual_compatibility_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ritualVersionId: uuid("ritual_version_id")
      .notNull()
      .references(() => ritualVersions.id, { onDelete: "cascade" }),
    religionId: uuid("religion_id").references(() => religions.id, {
      onDelete: "cascade",
    }),
    denominationId: uuid("denomination_id").references(() => denominations.id, {
      onDelete: "cascade",
    }),
    cultureId: uuid("culture_id").references(() => culturalTraditions.id, {
      onDelete: "cascade",
    }),
    country: text("country"),
    level: compatibilityLevel("level").notNull(),
    /** Message key, so the explanation is translated like any other copy. */
    explanationKey: text("explanation_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("ritual_compatibility_version_idx").on(table.ritualVersionId),
    index("ritual_compatibility_religion_idx").on(table.religionId),
  ],
);

export type Religion = typeof religions.$inferSelect;
export type RitualVersion = typeof ritualVersions.$inferSelect;
export type RitualCompatibilityRule = typeof ritualCompatibilityRules.$inferSelect;
