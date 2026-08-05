import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import {
  accounts,
  interests,
  privacySettings,
  profileInterests,
  profilePhotos,
  profilePreferences,
  profiles,
  sessions,
  users,
  verificationAttempts,
  verifications,
} from "@/db/schema";

const configFor = (table: PgTable) => getTableConfig(table);

const uniqueColumnSets = (table: PgTable) =>
  [
    ...configFor(table).uniqueConstraints.map((constraint) =>
      constraint.columns.map((column) => column.name),
    ),
    ...configFor(table).columns
      .filter((column) => column.isUnique)
      .map((column) => [column.name]),
    ...configFor(table).indexes
      .filter((index) => index.config.unique)
      .map((index) =>
        index.config.columns.flatMap((column) =>
          "name" in column && typeof column.name === "string" ? [column.name] : [],
        ),
      ),
  ];

const indexNames = (table: PgTable) =>
  configFor(table).indexes.map((index) => index.config.name);

const foreignKeysFor = (table: PgTable) =>
  configFor(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      foreignTable: configFor(reference.foreignTable).name,
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      onDelete: foreignKey.onDelete,
    };
  });

const dialect = new PgDialect();
const checksFor = (table: PgTable) => new Map(
  configFor(table).checks.map((constraint) => [
    constraint.name,
    dialect.sqlToQuery(constraint.value).sql,
  ]),
);

describe("profiles schema", () => {
  it("stores inclusive identity and discovery state", () => {
    const columns = getTableColumns(profiles);
    expect(Object.keys(columns)).toEqual(expect.arrayContaining([
      "userId", "displayName", "birthDate", "genderCode", "countryCode",
      "city", "bio", "discoverable", "status",
    ]));
  });

  it("exports auth, profile, privacy, interest, photo, and verification tables", () => {
    expect([
      users,
      sessions,
      accounts,
      verifications,
      profiles,
      profilePreferences,
      profilePhotos,
      interests,
      profileInterests,
      privacySettings,
      verificationAttempts,
    ].map((table) => configFor(table).name)).toEqual([
      "users",
      "sessions",
      "accounts",
      "verifications",
      "profiles",
      "profile_preferences",
      "profile_photos",
      "interests",
      "profile_interests",
      "privacy_settings",
      "verification_attempts",
    ]);
  });

  it("uses extensible text identity codes and date-only birth dates", () => {
    const columns = getTableColumns(profiles);

    expect(columns.genderCode.getSQLType()).toBe("text");
    expect(columns.genderCode.enumValues).toBeUndefined();
    expect(columns.birthDate.getSQLType()).toBe("date");
    expect(columns.countryCode.getSQLType()).toBe("varchar(2)");

    const preferenceColumns = getTableColumns(profilePreferences);
    expect(preferenceColumns.genderCodes.getSQLType()).toBe("text[]");
    expect(preferenceColumns.preferredCountryCodes.getSQLType()).toBe("varchar(2)[]");
  });

  it("enforces unique auth and one-to-one profile identifiers", () => {
    expect(uniqueColumnSets(users)).toContainEqual(["email"]);
    expect(uniqueColumnSets(sessions)).toContainEqual(["token"]);
    expect(uniqueColumnSets(accounts)).toContainEqual(["provider_id", "account_id"]);
    expect(uniqueColumnSets(profiles)).toContainEqual(["user_id"]);
    expect(uniqueColumnSets(profiles)).toContainEqual(["id", "user_id"]);
    expect(uniqueColumnSets(profilePreferences)).toContainEqual(["user_id"]);
    expect(uniqueColumnSets(privacySettings)).toContainEqual(["user_id"]);
    expect(uniqueColumnSets(profilePhotos)).toContainEqual(["object_key"]);
    expect(uniqueColumnSets(profilePhotos)).toContainEqual(["profile_id", "position"]);
    expect(uniqueColumnSets(interests)).toContainEqual(["code"]);
    expect(uniqueColumnSets(profileInterests)).toContainEqual(["profile_id", "interest_id"]);
  });

  it("defines discovery and moderation indexes", () => {
    expect(indexNames(profiles)).toEqual(expect.arrayContaining([
      "profiles_discovery_idx",
      "profiles_country_birth_date_idx",
    ]));
    expect(indexNames(profilePhotos)).toEqual(expect.arrayContaining([
      "profile_photos_moderation_status_idx",
      "profile_photos_profile_position_unique_idx",
    ]));
    expect(indexNames(verifications)).toContain("verifications_identifier_idx");
    expect(indexNames(verificationAttempts)).toEqual(expect.arrayContaining([
      "verification_attempts_user_idx",
      "verification_attempts_status_idx",
    ]));
  });

  it("uses deliberate cascade and audit-preserving foreign keys", () => {
    expect(foreignKeysFor(profiles)).toContainEqual({
      columns: ["user_id"],
      foreignTable: "users",
      foreignColumns: ["id"],
      onDelete: "cascade",
    });
    expect(foreignKeysFor(profilePhotos)).toEqual(expect.arrayContaining([
      {
        columns: ["user_id"],
        foreignTable: "users",
        foreignColumns: ["id"],
        onDelete: "cascade",
      },
      {
        columns: ["profile_id", "user_id"],
        foreignTable: "profiles",
        foreignColumns: ["id", "user_id"],
        onDelete: "cascade",
      },
    ]));
    expect(foreignKeysFor(verificationAttempts)).toContainEqual({
      columns: ["user_id"],
      foreignTable: "users",
      foreignColumns: ["id"],
      onDelete: "set null",
    });
  });

  it("validates uppercase country codes, including every preference array element", () => {
    const profileChecks = checksFor(profiles);
    expect(profileChecks.get("profiles_country_code_format_check")).toContain("^[A-Z]{2}$");

    const preferenceCheck = checksFor(profilePreferences).get(
      "profile_preferences_country_codes_format_check",
    );
    expect(preferenceCheck).not.toMatch(/SELECT|unnest/i);
    expect(preferenceCheck).toContain("array_position");
    expect(preferenceCheck).toContain("cardinality");
    expect(preferenceCheck).toContain("array_to_string");
    expect(preferenceCheck).toContain("[A-Z]{2}");
  });

  it("constrains finite statuses while keeping identity and verification kinds extensible", () => {
    expect(checksFor(profiles).get("profiles_status_check")).toMatch(
      /draft.*active.*restricted.*suspended.*banned/,
    );
    expect(checksFor(profilePhotos).get("profile_photos_moderation_status_check")).toMatch(
      /pending.*approved.*rejected/,
    );
    expect(checksFor(verificationAttempts).get("verification_attempts_status_check")).toMatch(
      /pending.*approved.*rejected.*expired/,
    );
    expect(checksFor(privacySettings).get("privacy_settings_location_precision_check")).toMatch(
      /hidden.*country.*city.*approximate/,
    );

    expect(getTableColumns(profiles).genderCode.enumValues).toBeUndefined();
    expect(getTableColumns(verificationAttempts).kind.enumValues).toBeUndefined();
  });

  it("prevents negative or duplicate photo positions within one profile", () => {
    expect(checksFor(profilePhotos).has("profile_photos_position_check")).toBe(true);
    expect(uniqueColumnSets(profilePhotos)).toContainEqual(["profile_id", "position"]);
  });

  it("uses timestamptz, required defaults, and appropriate nullability", () => {
    const profileColumns = getTableColumns(profiles);
    expect(profileColumns.createdAt.getSQLType()).toBe("timestamp with time zone");
    expect(profileColumns.updatedAt.getSQLType()).toBe("timestamp with time zone");
    expect(profileColumns.createdAt.hasDefault).toBe(true);
    expect(profileColumns.updatedAt.hasDefault).toBe(true);
    expect(profileColumns.discoverable.notNull).toBe(true);
    expect(profileColumns.discoverable.hasDefault).toBe(true);
    expect(profileColumns.status.notNull).toBe(true);

    const authColumns = getTableColumns(users);
    expect(authColumns.email.notNull).toBe(true);
    expect(authColumns.emailVerified.notNull).toBe(true);
    expect(authColumns.emailVerified.hasDefault).toBe(true);

    const attemptColumns = getTableColumns(verificationAttempts);
    expect(attemptColumns.userId.notNull).toBe(false);
    expect(attemptColumns.expiresAt.getSQLType()).toBe("timestamp with time zone");
    expect(attemptColumns.expiresAt.notNull).toBe(true);
    expect(attemptColumns.providerReference.notNull).toBe(false);
  });
});
