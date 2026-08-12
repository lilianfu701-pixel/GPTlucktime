import { and, eq, gt, inArray, lte } from "drizzle-orm";

import { moderationContentQuarantines } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type ModerationDatabase = typeof productionDatabase;

export interface ModerationContentPolicy {
  filterVisibleMessageIdsInTransaction(
    transaction: unknown,
    messageIds: readonly string[],
    now: Date,
  ): Promise<ReadonlySet<string>>;
}

export class DrizzleModerationContentPolicy implements ModerationContentPolicy {
  async filterVisibleMessageIdsInTransaction(transaction: unknown, messageIds: readonly string[], now: Date) {
    if (messageIds.length === 0) return new Set<string>();
    const uniqueIds = [...new Set(messageIds)];
    const quarantined = await (transaction as ModerationDatabase).select({
      contentId: moderationContentQuarantines.contentId,
    }).from(moderationContentQuarantines).where(and(
      eq(moderationContentQuarantines.contentType, "message"),
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
  filterVisibleMessageIdsInTransaction: async (_transaction, messageIds) => new Set(messageIds),
};
