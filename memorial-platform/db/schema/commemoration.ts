import {
  boolean,
  index,
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

export type MemorialRitualSetting = typeof memorialRitualSettings.$inferSelect;
