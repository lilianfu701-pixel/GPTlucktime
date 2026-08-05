import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
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
const createdAt = () => timestamptz("created_at").defaultNow().notNull();
const updatedAt = () =>
  timestamptz("updated_at").defaultNow().notNull().$onUpdate(() => new Date());
const emptyTextArray = sql`'{}'::text[]`;
const emptyCountryCodeArray = sql`'{}'::varchar(2)[]`;

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    birthDate: date("birth_date").notNull(),
    genderCode: text("gender_code").notNull(),
    relationshipGoalCode: text("relationship_goal_code"),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    city: text("city"),
    bio: text("bio"),
    discoverable: boolean("discoverable").default(true).notNull(),
    status: text("status").default("active").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("profiles_id_user_id_unique").on(table.id, table.userId),
    index("profiles_discovery_idx").on(table.discoverable, table.status),
    index("profiles_country_birth_date_idx").on(table.countryCode, table.birthDate),
    check("profiles_country_code_format_check", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check(
      "profiles_status_check",
      sql`${table.status} IN ('draft', 'active', 'restricted', 'suspended', 'banned')`,
    ),
  ],
);

export const profilePreferences = pgTable(
  "profile_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    genderCodes: text("gender_codes").array().default(emptyTextArray).notNull(),
    minimumAge: integer("minimum_age").default(18).notNull(),
    maximumAge: integer("maximum_age").default(100).notNull(),
    preferredCountryCodes: varchar("preferred_country_codes", { length: 2 })
      .array()
      .default(emptyCountryCodeArray)
      .notNull(),
    languageCodes: text("language_codes").array().default(emptyTextArray).notNull(),
    relationshipGoalCodes: text("relationship_goal_codes").array().default(emptyTextArray).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "profile_preferences_age_range_check",
      sql`${table.minimumAge} >= 18 AND ${table.maximumAge} <= 120 AND ${table.minimumAge} <= ${table.maximumAge}`,
    ),
    check(
      "profile_preferences_country_codes_format_check",
      sql`array_position(${table.preferredCountryCodes}, NULL) IS NULL
        AND (
          cardinality(${table.preferredCountryCodes}) = 0
          OR array_to_string(${table.preferredCountryCodes}, ',')
            ~ '^([A-Z]{2})(,[A-Z]{2})*$'
        )`,
    ),
  ],
);

export const profilePhotos = pgTable(
  "profile_photos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    objectKey: text("object_key").notNull().unique(),
    position: integer("position").default(0).notNull(),
    moderationStatus: text("moderation_status").default("pending").notNull(),
    moderationReasonCode: text("moderation_reason_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("profile_photos_moderation_status_idx").on(table.moderationStatus),
    uniqueIndex("profile_photos_profile_position_unique_idx").on(
      table.profileId,
      table.position,
    ),
    foreignKey({
      name: "profile_photos_profile_owner_fk",
      columns: [table.profileId, table.userId],
      foreignColumns: [profiles.id, profiles.userId],
    }).onDelete("cascade"),
    check("profile_photos_position_check", sql`${table.position} >= 0`),
    check(
      "profile_photos_moderation_status_check",
      sql`${table.moderationStatus} IN ('pending', 'approved', 'rejected')`,
    ),
  ],
);

export const interests = pgTable("interests", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const profileInterests = pgTable(
  "profile_interests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    interestId: uuid("interest_id")
      .notNull()
      .references(() => interests.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("profile_interests_profile_interest_unique").on(table.profileId, table.interestId),
    index("profile_interests_interest_idx").on(table.interestId),
  ],
);

export const privacySettings = pgTable(
  "privacy_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    showOnlineStatus: boolean("show_online_status").default(true).notNull(),
    showLastActive: boolean("show_last_active").default(true).notNull(),
    showProfileVisitors: boolean("show_profile_visitors").default(true).notNull(),
    locationPrecision: text("location_precision").default("city").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "privacy_settings_location_precision_check",
      sql`${table.locationPrecision} IN ('hidden', 'country', 'city', 'approximate')`,
    ),
  ],
);

export const verificationAttempts = pgTable(
  "verification_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    providerReference: text("provider_reference"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("verification_attempts_user_idx").on(table.userId),
    index("verification_attempts_status_idx").on(table.status),
    check(
      "verification_attempts_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired')`,
    ),
  ],
);
