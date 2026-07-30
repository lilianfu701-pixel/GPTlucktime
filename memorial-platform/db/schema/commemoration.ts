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
import { memorials } from "./memorial";
import { ritualDefinitions, ritualVersions } from "./religion";

export const moderationMode = pgEnum("moderation_mode", [
  "pre_review",
  "post_review",
]);

/**
 * What one family has decided to offer on their memorial.
 *
 * The row points at an exact `ritualVersionId`, not at a definition. That is the
 * mechanism doc 05 section 5 requires: when the catalogue publishes a revision,
 * this memorial keeps offering the wording the family agreed to. A newer
 * revision reaches them only if they choose it.
 *
 * A row exists only because someone with the authority to configure the memorial
 * created it. There is no default and no implicit enablement: selecting a
 * religion turns nothing on.
 */
export const memorialRitualSettings = pgTable(
  "memorial_ritual_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    /** Stored alongside the version so one definition cannot be enabled twice. */
    ritualDefinitionId: uuid("ritual_definition_id")
      .notNull()
      .references(() => ritualDefinitions.id, { onDelete: "restrict" }),
    ritualVersionId: uuid("ritual_version_id")
      .notNull()
      .references(() => ritualVersions.id, { onDelete: "restrict" }),

    enabled: boolean("enabled").default(false).notNull(),
    /** The family's own wording for this action, where they prefer their own. */
    displayNameOverride: text("display_name_override"),
    allowAnonymous: boolean("allow_anonymous").default(false).notNull(),
    allowMessage: boolean("allow_message").default(true).notNull(),
    moderationMode: moderationMode("moderation_mode")
      .default("pre_review")
      .notNull(),

    /**
     * Who agreed, and when. Recorded because a family's acceptance of a
     * particular revision is the thing a later dispute or a retirement notice
     * has to refer back to.
     */
    familyConfirmedAt: timestamp("family_confirmed_at", { withTimezone: true }),
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    // One revision per way of remembering. A memorial cannot offer two versions
    // of the same action at once.
    uniqueIndex("memorial_ritual_settings_definition_key").on(
      table.memorialId,
      table.ritualDefinitionId,
    ),
    index("memorial_ritual_settings_memorial_idx").on(
      table.memorialId,
      table.enabled,
    ),
  ],
);

export const commemorationStatus = pgEnum("commemoration_status", [
  "visible",
  "pending_review",
  "rejected",
  "hidden",
]);

/**
 * One act of remembrance by a visitor.
 *
 * `ritualVersionId` records which revision was offered at the time, so a
 * commemoration remains interpretable after the catalogue moves on.
 *
 * These rows are counted for display but never ranked. Doc 01 section 4.3
 * forbids leaderboards: a family should not be able to tell that another
 * memorial received more flowers than theirs.
 */
export const commemorations = pgTable(
  "commemorations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    ritualVersionId: uuid("ritual_version_id")
      .notNull()
      .references(() => ritualVersions.id, { onDelete: "restrict" }),
    /** Null for a visitor the family allowed to act without signing in. */
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** True where a signed-in visitor asked not to be named. */
    anonymous: boolean("anonymous").default(false).notNull(),
    locale: text("locale").notNull(),
    status: commemorationStatus("status").default("visible").notNull(),

    idempotencyKey: text("idempotency_key").notNull(),
    /**
     * Hash of the meaningful request fields. Lets a retry be told apart from a
     * different request that happens to reuse a key, which doc 04 section 10
     * requires answering with a conflict rather than a silent replay.
     */
    requestHash: text("request_hash").notNull(),
    /** Hashed, so a record of who visited is not a list of addresses. */
    requestIpHash: text("request_ip_hash"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("commemorations_memorial_idempotency_key").on(
      table.memorialId,
      table.idempotencyKey,
    ),
    index("commemorations_memorial_idx").on(table.memorialId, table.status),
    index("commemorations_actor_idx").on(table.actorUserId, table.createdAt),
    index("commemorations_ip_idx").on(table.requestIpHash, table.createdAt),
  ],
);

/**
 * The words a visitor left, held separately from the act.
 *
 * Separate because the two are moderated differently: a family may want the
 * flowers to appear immediately while reading the message first. Removing an
 * unkind message does not have to erase the fact that someone came.
 */
export const commemorationMessages = pgTable(
  "commemoration_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    commemorationId: uuid("commemoration_id")
      .notNull()
      .references(() => commemorations.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    sourceLocale: text("source_locale").notNull(),
    moderationStatus: commemorationStatus("moderation_status")
      .default("pending_review")
      .notNull(),
    moderatedByUserId: uuid("moderated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("commemoration_messages_commemoration_key").on(
      table.commemorationId,
    ),
    index("commemoration_messages_status_idx").on(table.moderationStatus),
  ],
);

/**
 * A date a family asked to be reminded of.
 *
 * The calendar, the adapter version and the time zone are all stored, not just
 * the computed instant. A date told to a family has to be explainable, and if a
 * corrected adapter later moves it, the reason has to be recoverable rather than
 * inferred from a changed timestamp.
 *
 * Nothing sends while `anniversary_notifications_enabled` is off, which is the
 * phase-one state per doc 09 section 9.
 */
export const anniversaryReminders = pgTable(
  "anniversary_reminders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    /** Which occasion: a death anniversary, a birthday, a family observance. */
    kind: text("kind").notNull(),

    calendarId: text("calendar_id").notNull(),
    /** The adapter version that produced `nextOccurrenceAt`. */
    adapterVersion: text("adapter_version").notNull(),
    sourceYear: integer("source_year").notNull(),
    sourceMonth: integer("source_month").notNull(),
    sourceDay: integer("source_day").notNull(),
    /** IANA identifier. An anniversary is the same date where the memorial is. */
    timeZone: text("time_zone").notNull(),

    nextOccurrenceAt: timestamp("next_occurrence_at", { withTimezone: true }),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    /** Set when the calendar cannot compute a date, so the failure is visible. */
    lastError: text("last_error"),

    enabled: boolean("enabled").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("anniversary_reminders_due_idx").on(
      table.enabled,
      table.nextOccurrenceAt,
    ),
    index("anniversary_reminders_memorial_idx").on(table.memorialId),
  ],
);

export type MemorialRitualSetting = typeof memorialRitualSettings.$inferSelect;
export type Commemoration = typeof commemorations.$inferSelect;
export type CommemorationMessage = typeof commemorationMessages.$inferSelect;
export type AnniversaryReminder = typeof anniversaryReminders.$inferSelect;
