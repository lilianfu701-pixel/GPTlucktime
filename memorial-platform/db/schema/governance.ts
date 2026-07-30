import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { memorials } from "./memorial";

/**
 * Someone a family has asked not to hear from again.
 *
 * Scoped to one memorial. A person who behaved badly on one page has not
 * necessarily done anything to another family, and a platform-wide ban is a
 * separate, audited governance action.
 *
 * The row is kept after being lifted, so a later dispute can show what was done
 * and when.
 */
export const blockedUsers = pgTable(
  "blocked_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    blockedUserId: uuid("blocked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedByUserId: uuid("blocked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Kept for the family's record. Never shown to the person blocked. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("blocked_users_memorial_user_key").on(
      table.memorialId,
      table.blockedUserId,
    ),
    index("blocked_users_memorial_idx").on(table.memorialId),
  ],
);

export type BlockedUser = typeof blockedUsers.$inferSelect;
