import { and, eq, gt, inArray, lte } from "drizzle-orm";

import { moderationContentQuarantines } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type ModerationDatabase = typeof productionDatabase;

export interface ModerationContentPolicy {
  filterVisibleProfileIdsInTransaction(
    transaction: unknown,
    profileIds: readonly string[],
    now: Date,
  ): Promise<ReadonlySet<string>>;
  filterVisibleMessageIdsInTransaction(
    transaction: unknown,
    messageIds: readonly string[],
    now: Date,
  ): Promise<ReadonlySet<string>>;
}

export class DrizzleModerationContentPolicy implements ModerationContentPolicy {
  async filterVisibleProfileIdsInTransaction(transaction: unknown, profileIds: readonly string[], now: Date) {
    return this.filterVisibleIdsInTransaction(transaction, "profile", profileIds, now);
  }

  async filterVisibleMessageIdsInTransaction(transaction: unknown, messageIds: readonly string[], now: Date) {
    return this.filterVisibleIdsInTransaction(transaction, "message", messageIds, now);
  }

  private async filterVisibleIdsInTransaction(
    transaction: unknown,
    contentType: "profile" | "message",
    contentIds: readonly string[],
    now: Date,
  ) {
    if (contentIds.length === 0) return new Set<string>();
    const uniqueIds = [...new Set(contentIds)];
    const quarantined = await (transaction as ModerationDatabase).select({
      contentId: moderationContentQuarantines.contentId,
    }).from(moderationContentQuarantines).where(and(
      eq(moderationContentQuarantines.contentType, contentType),
      inArray(moderationContentQuarantines.contentId, uniqueIds),
      eq(moderationContentQuarantines.active, true),
      lte(moderationContentQuarantines.startsAt, now),
      gt(moderationContentQuarantines.preserveUntil, now),
    ));
    const hidden = new Set(quarantined.map(({ contentId }) => contentId));
    return new Set(uniqueIds.filter((id) => !hidden.has(id)));
  }
}

export const allowAllContentPolicy: ModerationContentPolicy = {
  filterVisibleProfileIdsInTransaction: async (_transaction, profileIds) => new Set(profileIds),
  filterVisibleMessageIdsInTransaction: async (_transaction, messageIds) => new Set(messageIds),
};
