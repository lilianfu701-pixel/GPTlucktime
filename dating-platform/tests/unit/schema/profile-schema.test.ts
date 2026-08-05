import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
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

const foreignKeyColumnSets = (table: PgTable) =>
  configFor(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      onDelete: foreignKey.onDelete,
    };
  });

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
  });

  it("enforces unique auth and one-to-one profile identifiers", () => {
    expect(uniqueColumnSets(users)).toContainEqual(["email"]);
    expect(uniqueColumnSets(sessions)).toContainEqual(["token"]);
    expect(uniqueColumnSets(accounts)).toContainEqual(["provider_id", "account_id"]);
    expect(uniqueColumnSets(profiles)).toContainEqual(["user_id"]);
    expect(uniqueColumnSets(profilePreferences)).toContainEqual(["user_id"]);
    expect(uniqueColumnSets(privacySettings)).toContainEqual(["user_id"]);
    expect(uniqueColumnSets(profilePhotos)).toContainEqual(["object_key"]);
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
      "profile_photos_profile_position_idx",
    ]));
    expect(indexNames(verifications)).toContain("verifications_identifier_idx");
    expect(indexNames(verificationAttempts)).toEqual(expect.arrayContaining([
      "verification_attempts_user_idx",
      "verification_attempts_status_idx",
    ]));
  });

  it("uses deliberate cascade and audit-preserving foreign keys", () => {
    expect(foreignKeyColumnSets(profiles)).toContainEqual({
      columns: ["user_id"],
      foreignColumns: ["id"],
      onDelete: "cascade",
    });
    expect(foreignKeyColumnSets(profilePhotos)).toEqual(expect.arrayContaining([
      {
        columns: ["user_id"],
        foreignColumns: ["id"],
        onDelete: "cascade",
      },
      {
        columns: ["profile_id"],
        foreignColumns: ["id"],
        onDelete: "cascade",
      },
    ]));
    expect(foreignKeyColumnSets(verificationAttempts)).toContainEqual({
      columns: ["user_id"],
      foreignColumns: ["id"],
      onDelete: "set null",
    });
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
