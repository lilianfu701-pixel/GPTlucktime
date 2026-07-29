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

export const userStatus = pgEnum("user_status", [
  "active",
  "suspended",
  "deleted",
]);

export const identityProvider = pgEnum("identity_provider", [
  "email",
  "phone",
  "google",
  "apple",
]);

export const loginChannel = pgEnum("login_channel", ["email", "phone"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  displayName: text("display_name"),
  preferredLocale: text("preferred_locale").default("en").notNull(),
  status: userStatus("status").default("active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * One row per way a person can prove who they are.
 *
 * Social accounts are keyed by the provider's stable subject, never by the
 * email address the provider reports: an address can be reassigned, and some
 * providers relay it. See 06-security-privacy-moderation.md section 2.
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: identityProvider("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_identities_provider_subject_key").on(
      table.provider,
      table.providerSubject,
    ),
    index("user_identities_user_idx").on(table.userId),
  ],
);

/** Normalized (lowercased, trimmed) address. One address, one account. */
export const emailCredentials = pgTable(
  "email_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("email_credentials_email_key").on(table.email)],
);

/** E.164 number. Present from the first release, hidden behind a feature flag. */
export const phoneCredentials = pgTable(
  "phone_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    phoneE164: text("phone_e164").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("phone_credentials_phone_key").on(table.phoneE164)],
);

/**
 * A pending one-time-code challenge.
 *
 * Held in PostgreSQL rather than a cache: the attempt counter is a security
 * control, and an eviction or a restart must not hand an attacker a fresh set
 * of guesses. `codeHash` is an HMAC keyed by a derived server secret; the code
 * itself is never stored.
 */
export const loginChallenges = pgTable(
  "login_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channel: loginChannel("channel").notNull(),
    /** Normalized address or E.164 number. */
    destination: text("destination").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** Hashed: the raw address is never written to an operational record. */
    requestIpHash: text("request_ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("login_challenges_destination_idx").on(
      table.destination,
      table.createdAt,
    ),
    index("login_challenges_expires_idx").on(table.expiresAt),
  ],
);

/** Append-only record of verification outcomes, for lockout and investigation. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    challengeId: uuid("challenge_id").references(() => loginChallenges.id, {
      onDelete: "set null",
    }),
    channel: loginChannel("channel").notNull(),
    /** Hashed destination: an attempt log must not become an address list. */
    destinationHash: text("destination_hash").notNull(),
    succeeded: boolean("succeeded").notNull(),
    /** Set when the attempt failed, so lockouts can be explained. */
    failureReason: text("failure_reason"),
    requestIpHash: text("request_ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("login_attempts_destination_idx").on(
      table.destinationHash,
      table.createdAt,
    ),
  ],
);

/** Only the hash of a session token is stored. See doc 06 section 2. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_key").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type LoginChallenge = typeof loginChallenges.$inferSelect;
export type Session = typeof sessions.$inferSelect;
