import { and, eq, gt, inArray, lte, or } from "drizzle-orm";

import { userRestrictions } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type ModerationDatabase = typeof productionDatabase;
export type RestrictionScope = "messaging" | "discovery";

export interface ModerationRestrictionPolicy {
  filterAllowedInTransaction(
    transaction: unknown,
    userIds: readonly string[],
    scope: RestrictionScope,
    now: Date,
  ): Promise<ReadonlySet<string>>;
}

export class DrizzleModerationRestrictionPolicy implements ModerationRestrictionPolicy {
  async filterAllowedInTransaction(
    transaction: unknown,
    userIds: readonly string[],
    scope: RestrictionScope,
    now: Date,
  ) {
    if (userIds.length === 0) return new Set<string>();
    const uniqueIds = [...new Set(userIds)];
    const rows = await (transaction as ModerationDatabase).select({
      subjectUserId: userRestrictions.subjectUserId,
    }).from(userRestrictions).where(and(
      inArray(userRestrictions.subjectUserId, uniqueIds),
      eq(userRestrictions.active, true),
      lte(userRestrictions.startsAt, now),
      gt(userRestrictions.expiresAt, now),
      or(eq(userRestrictions.scope, "all_interactions"), eq(userRestrictions.scope, scope)),
    ));
    const restricted = new Set(rows.map(({ subjectUserId }) => subjectUserId));
    return new Set(uniqueIds.filter((id) => !restricted.has(id)));
  }
}

export const allowAllRestrictionPolicy: ModerationRestrictionPolicy = {
  filterAllowedInTransaction: async (_transaction, userIds) => new Set(userIds),
};
