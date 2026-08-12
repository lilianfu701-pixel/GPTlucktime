import { and, eq, inArray } from "drizzle-orm";

import { moderationMediaHolds } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type ModerationDatabase = typeof productionDatabase;

export interface MediaLegalHoldPolicy {
  filterDeletablePhotoIds(photoIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export class DrizzleMediaLegalHoldPolicy implements MediaLegalHoldPolicy {
  constructor(private readonly database: ModerationDatabase) {}

  async filterDeletablePhotoIds(photoIds: readonly string[]) {
    if (photoIds.length === 0) return new Set<string>();
    const uniqueIds = [...new Set(photoIds)];
    const held = await this.database.select({ photoId: moderationMediaHolds.photoId })
      .from(moderationMediaHolds).where(and(
        inArray(moderationMediaHolds.photoId, uniqueIds),
        eq(moderationMediaHolds.active, true),
      ));
    const heldIds = new Set(held.map(({ photoId }) => photoId));
    return new Set(uniqueIds.filter((id) => !heldIds.has(id)));
  }
}

export const allowAllMediaLegalHoldPolicy: MediaLegalHoldPolicy = {
  filterDeletablePhotoIds: async (photoIds) => new Set(photoIds),
};
