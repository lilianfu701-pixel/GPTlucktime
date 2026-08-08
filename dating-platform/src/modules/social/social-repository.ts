import { createHmac, timingSafeEqual } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import {
  interests,
  privacySettings,
  profileInterests,
  profilePhotos,
  profilePreferences,
  profiles,
  profileViews,
  realtimePairRevocations,
  socialActionIdempotency,
  socialFavorites,
  socialLikes,
  socialMatches,
  socialOutboxEvents,
  userBlocks,
  users,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import { ageOn } from "@/modules/discovery/candidate-policy";
import { publicProfile } from "@/modules/profiles/profile-service";

type SocialDatabase = typeof productionDatabase;
type SocialTransaction = SocialDatabase;
type SocialAction = "like" | "favorite" | "view" | "block";
type PageInput = { pageSize: number; cursor?: string };
type LikesPageInput = PageInput & { direction: "sent" | "received" };
type Cursor = { timestamp: string; id: string };

const ageBand = (age: number) => `${Math.floor(age / 5) * 5}-${Math.floor(age / 5) * 5 + 4}`;
const orderedPair = (left: string, right: string) => left < right
  ? { lowUserId: left, highUserId: right }
  : { lowUserId: right, highUserId: left };

const digest = (secret: string, ...parts: string[]) => createHmac("sha256", secret)
  .update(parts.join("\u0000"))
  .digest("hex");

const signCursor = (body: string, secret: string) => createHmac("sha256", secret)
  .update(body)
  .digest("base64url");

const encodeCursor = (cursor: Cursor, secret: string) => {
  const body = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  return `${body}.${signCursor(body, secret)}`;
};

const decodeCursor = (value: string | undefined, secret: string): Cursor | null => {
  if (!value) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra || body.length > 1024 || signature.length > 100) {
    throw new Error("INVALID_CURSOR");
  }
  const expected = signCursor(body, secret);
  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new Error("INVALID_CURSOR");
  }
  try {
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(decoded).length !== 2
      || typeof decoded.timestamp !== "string"
      || Number.isNaN(new Date(decoded.timestamp).getTime())
      || typeof decoded.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(decoded.id)) throw new Error();
    return { timestamp: decoded.timestamp, id: decoded.id };
  } catch {
    throw new Error("INVALID_CURSOR");
  }
};

const blockedSql = (ownerUserId: string, otherUserColumn: SQLWrapper) => sql`NOT EXISTS (
  SELECT 1 FROM ${userBlocks} social_block
  WHERE (social_block.blocker_user_id = ${ownerUserId}
    AND social_block.blocked_user_id = ${otherUserColumn})
    OR (social_block.blocked_user_id = ${ownerUserId}
      AND social_block.blocker_user_id = ${otherUserColumn})
)`;

export async function assertInteractionAllowed(
  policy: Pick<SocialRepository, "assertInteractionAllowed">,
  actorUserId: string,
  targetUserId: string,
) {
  await policy.assertInteractionAllowed(actorUserId, targetUserId);
}

export class SocialRepository {
  private readonly database: SocialDatabase;
  private readonly clock: () => Date;
  private readonly cursorSecret: string;
  private readonly idempotencySecret: string;

  constructor(database: unknown, options: {
    clock?: () => Date;
    cursorSecret: string;
    idempotencySecret: string;
  }) {
    this.database = database as SocialDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.cursorSecret = options.cursorSecret;
    this.idempotencySecret = options.idempotencySecret;
  }

  async assertInteractionAllowed(actorUserId: string, targetUserId: string) {
    if (actorUserId === targetUserId) throw new Error("INTERACTION_NOT_ALLOWED");
    const [block] = await this.database.select({ id: userBlocks.id }).from(userBlocks).where(or(
      and(eq(userBlocks.blockerUserId, actorUserId), eq(userBlocks.blockedUserId, targetUserId)),
      and(eq(userBlocks.blockerUserId, targetUserId), eq(userBlocks.blockedUserId, actorUserId)),
    )).limit(1);
    if (block) throw new Error("INTERACTION_NOT_ALLOWED");
  }

  async like(actorUserId: string, targetProfileId: string, idempotencyKey: string) {
    return this.runAction(actorUserId, targetProfileId, "like", idempotencyKey, async (tx, targetUserId, now) => {
      await tx.insert(socialLikes).values({ actorUserId, targetUserId, active: true, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [socialLikes.actorUserId, socialLikes.targetUserId],
          set: { active: true, revokedAt: null, updatedAt: now },
        });
      const [reverse] = await tx.select({ id: socialLikes.id }).from(socialLikes).where(and(
        eq(socialLikes.actorUserId, targetUserId),
        eq(socialLikes.targetUserId, actorUserId),
        eq(socialLikes.active, true),
      )).limit(1);
      if (!reverse) return { liked: true, matched: false };

      const pair = orderedPair(actorUserId, targetUserId);
      let [match] = await tx.select().from(socialMatches).where(and(
        eq(socialMatches.lowUserId, pair.lowUserId),
        eq(socialMatches.highUserId, pair.highUserId),
      )).limit(1);
      let created = false;
      if (!match) {
        [match] = await tx.insert(socialMatches).values({ ...pair, status: "active", createdAt: now, updatedAt: now })
          .onConflictDoNothing().returning();
        created = Boolean(match);
        if (!match) {
          [match] = await tx.select().from(socialMatches).where(and(
            eq(socialMatches.lowUserId, pair.lowUserId),
            eq(socialMatches.highUserId, pair.highUserId),
          )).limit(1);
        }
      } else if (match.status !== "active") {
        [match] = await tx.update(socialMatches).set({
          status: "active", hiddenAt: null, createdAt: now, updatedAt: now,
        }).where(eq(socialMatches.id, match.id)).returning();
        created = true;
      }
      if (!match) throw new Error("SOCIAL_WRITE_FAILED");
      if (created) {
        await tx.insert(socialOutboxEvents).values({
          eventType: "match.created",
          aggregateType: "match",
          aggregateId: match.id,
          dedupeKey: `match.created:${match.id}:${match.createdAt.toISOString()}`,
          payload: { matchId: match.id, lowUserId: pair.lowUserId, highUserId: pair.highUserId },
          status: "pending",
          availableAt: now,
          createdAt: now,
        }).onConflictDoNothing();
      }
      return { liked: true, matched: true, matchId: match.id };
    });
  }

  async favorite(actorUserId: string, targetProfileId: string, idempotencyKey: string) {
    return this.runAction(actorUserId, targetProfileId, "favorite", idempotencyKey, async (tx, targetUserId, now) => {
      await tx.insert(socialFavorites).values({ ownerUserId: actorUserId, targetUserId, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [socialFavorites.ownerUserId, socialFavorites.targetUserId],
          set: { updatedAt: now },
        });
      return { favorited: true };
    });
  }

  async view(actorUserId: string, targetProfileId: string, idempotencyKey: string) {
    return this.runAction(actorUserId, targetProfileId, "view", idempotencyKey, async (tx, targetUserId, now) => {
      await tx.insert(profileViews).values({
        viewerUserId: actorUserId,
        viewedUserId: targetUserId,
        viewCount: 1,
        firstViewedAt: now,
        lastViewedAt: now,
      }).onConflictDoUpdate({
        target: [profileViews.viewerUserId, profileViews.viewedUserId],
        set: {
          viewCount: sql`least(2147483647, ${profileViews.viewCount} + 1)`,
          lastViewedAt: now,
        },
      });
      return { viewed: true };
    });
  }

  async block(actorUserId: string, targetProfileId: string, idempotencyKey: string) {
    return this.runAction(actorUserId, targetProfileId, "block", idempotencyKey, async (tx, targetUserId, now) => {
      const [inserted] = await tx.insert(userBlocks).values({
        blockerUserId: actorUserId,
        blockedUserId: targetUserId,
        createdAt: now,
      }).onConflictDoNothing().returning({ id: userBlocks.id });
      if (!inserted) return { blocked: true };

      const pair = orderedPair(actorUserId, targetUserId);
      await tx.update(socialMatches).set({ status: "blocked", hiddenAt: now, updatedAt: now }).where(and(
        eq(socialMatches.lowUserId, pair.lowUserId),
        eq(socialMatches.highUserId, pair.highUserId),
      ));
      await tx.update(socialLikes).set({ active: false, revokedAt: now, updatedAt: now }).where(or(
        and(eq(socialLikes.actorUserId, actorUserId), eq(socialLikes.targetUserId, targetUserId)),
        and(eq(socialLikes.actorUserId, targetUserId), eq(socialLikes.targetUserId, actorUserId)),
      ));
      await tx.delete(socialFavorites).where(or(
        and(eq(socialFavorites.ownerUserId, actorUserId), eq(socialFavorites.targetUserId, targetUserId)),
        and(eq(socialFavorites.ownerUserId, targetUserId), eq(socialFavorites.targetUserId, actorUserId)),
      ));
      await tx.insert(realtimePairRevocations).values({ ...pair, revokedBefore: now, version: 1, updatedAt: now })
        .onConflictDoUpdate({
          target: [realtimePairRevocations.lowUserId, realtimePairRevocations.highUserId],
          set: {
            revokedBefore: now,
            version: sql`${realtimePairRevocations.version} + 1`,
            updatedAt: now,
          },
        });
      return { blocked: true };
    }, { allowBlockCreation: true });
  }

  async unlike(actorUserId: string, targetProfileId: string) {
    return this.withTargetPair(actorUserId, targetProfileId, async (tx, targetUserId, now) => {
      await tx.update(socialLikes).set({ active: false, revokedAt: now, updatedAt: now }).where(and(
        eq(socialLikes.actorUserId, actorUserId),
        eq(socialLikes.targetUserId, targetUserId),
      ));
      const pair = orderedPair(actorUserId, targetUserId);
      await tx.update(socialMatches).set({ status: "hidden", hiddenAt: now, updatedAt: now }).where(and(
        eq(socialMatches.lowUserId, pair.lowUserId),
        eq(socialMatches.highUserId, pair.highUserId),
        eq(socialMatches.status, "active"),
      ));
      return { liked: false };
    }, false);
  }

  async removeFavorite(actorUserId: string, targetProfileId: string) {
    return this.withTargetPair(actorUserId, targetProfileId, async (tx, targetUserId) => {
      await tx.delete(socialFavorites).where(and(
        eq(socialFavorites.ownerUserId, actorUserId),
        eq(socialFavorites.targetUserId, targetUserId),
      ));
      return { favorited: false };
    }, false);
  }

  async unblock(actorUserId: string, targetProfileId: string) {
    return this.withTargetPair(actorUserId, targetProfileId, async (tx, targetUserId) => {
      await tx.delete(userBlocks).where(and(
        eq(userBlocks.blockerUserId, actorUserId),
        eq(userBlocks.blockedUserId, targetUserId),
      ));
      return { blocked: false };
    }, false);
  }

  async listMatches(userId: string, input: PageInput) {
    const cursor = decodeCursor(input.cursor, this.cursorSecret);
    const otherUser = sql<string>`case when ${socialMatches.lowUserId} = ${userId}
      then ${socialMatches.highUserId} else ${socialMatches.lowUserId} end`;
    const rows = await this.database.select({
      id: socialMatches.id,
      otherUserId: otherUser,
      createdAt: socialMatches.createdAt,
    }).from(socialMatches).where(and(
      eq(socialMatches.status, "active"),
      or(eq(socialMatches.lowUserId, userId), eq(socialMatches.highUserId, userId)),
      blockedSql(userId, otherUser),
      cursor ? or(
        lt(socialMatches.createdAt, new Date(cursor.timestamp)),
        and(eq(socialMatches.createdAt, new Date(cursor.timestamp)), gt(socialMatches.id, cursor.id)),
      ) : undefined,
    )).orderBy(desc(socialMatches.createdAt), asc(socialMatches.id)).limit(input.pageSize + 1);
    const page = rows.slice(0, input.pageSize);
    const profilesByUser = await this.publicProfiles(page.map(({ otherUserId }) => otherUserId));
    const items = page.flatMap((row) => {
      const profile = profilesByUser.get(row.otherUserId);
      return profile ? [{ id: row.id, matchedAt: row.createdAt.toISOString(), profile }] : [];
    });
    return this.pageResult(items, rows, input.pageSize, (row) => ({ timestamp: row.createdAt.toISOString(), id: row.id }));
  }

  async listLikes(userId: string, input: LikesPageInput) {
    const cursor = decodeCursor(input.cursor, this.cursorSecret);
    const ownerColumn = input.direction === "sent" ? socialLikes.actorUserId : socialLikes.targetUserId;
    const otherColumn = input.direction === "sent" ? socialLikes.targetUserId : socialLikes.actorUserId;
    const rows = await this.database.select({
      id: socialLikes.id,
      otherUserId: otherColumn,
      createdAt: socialLikes.createdAt,
    }).from(socialLikes).where(and(
      eq(ownerColumn, userId),
      eq(socialLikes.active, true),
      blockedSql(userId, otherColumn),
      cursor ? or(
        lt(socialLikes.createdAt, new Date(cursor.timestamp)),
        and(eq(socialLikes.createdAt, new Date(cursor.timestamp)), gt(socialLikes.id, cursor.id)),
      ) : undefined,
    )).orderBy(desc(socialLikes.createdAt), asc(socialLikes.id)).limit(input.pageSize + 1);
    const page = rows.slice(0, input.pageSize);
    const profilesByUser = await this.publicProfiles(page.map(({ otherUserId }) => otherUserId));
    const items = page.flatMap((row) => {
      const profile = profilesByUser.get(row.otherUserId);
      return profile ? [{ id: row.id, likedAt: row.createdAt.toISOString(), profile }] : [];
    });
    return this.pageResult(items, rows, input.pageSize, (row) => ({ timestamp: row.createdAt.toISOString(), id: row.id }));
  }

  async listFavorites(userId: string, input: PageInput) {
    const cursor = decodeCursor(input.cursor, this.cursorSecret);
    const rows = await this.database.select({
      id: socialFavorites.id,
      otherUserId: socialFavorites.targetUserId,
      createdAt: socialFavorites.createdAt,
    }).from(socialFavorites).where(and(
      eq(socialFavorites.ownerUserId, userId),
      blockedSql(userId, socialFavorites.targetUserId),
      cursor ? or(
        lt(socialFavorites.createdAt, new Date(cursor.timestamp)),
        and(eq(socialFavorites.createdAt, new Date(cursor.timestamp)), gt(socialFavorites.id, cursor.id)),
      ) : undefined,
    )).orderBy(desc(socialFavorites.createdAt), asc(socialFavorites.id)).limit(input.pageSize + 1);
    const page = rows.slice(0, input.pageSize);
    const profilesByUser = await this.publicProfiles(page.map(({ otherUserId }) => otherUserId));
    const items = page.flatMap((row) => {
      const profile = profilesByUser.get(row.otherUserId);
      return profile ? [{ id: row.id, favoritedAt: row.createdAt.toISOString(), profile }] : [];
    });
    return this.pageResult(items, rows, input.pageSize, (row) => ({ timestamp: row.createdAt.toISOString(), id: row.id }));
  }

  async listVisitors(userId: string, input: PageInput) {
    const [ownerPrivacy] = await this.database.select({ enabled: privacySettings.showProfileVisitors })
      .from(privacySettings).where(eq(privacySettings.userId, userId)).limit(1);
    if (!ownerPrivacy?.enabled) return { items: [], nextCursor: null };
    const cursor = decodeCursor(input.cursor, this.cursorSecret);
    const rows = await this.database.select({
      id: profileViews.id,
      otherUserId: profileViews.viewerUserId,
      viewCount: profileViews.viewCount,
      lastViewedAt: profileViews.lastViewedAt,
    }).from(profileViews)
      .innerJoin(privacySettings, eq(privacySettings.userId, profileViews.viewerUserId))
      .where(and(
        eq(profileViews.viewedUserId, userId),
        eq(privacySettings.showProfileVisitors, true),
        blockedSql(userId, profileViews.viewerUserId),
        cursor ? or(
          lt(profileViews.lastViewedAt, new Date(cursor.timestamp)),
          and(eq(profileViews.lastViewedAt, new Date(cursor.timestamp)), gt(profileViews.id, cursor.id)),
        ) : undefined,
      )).orderBy(desc(profileViews.lastViewedAt), asc(profileViews.id)).limit(input.pageSize + 1);
    const page = rows.slice(0, input.pageSize);
    const profilesByUser = await this.publicProfiles(page.map(({ otherUserId }) => otherUserId));
    const items = page.flatMap((row) => {
      const profile = profilesByUser.get(row.otherUserId);
      return profile ? [{
        id: row.id,
        viewCount: row.viewCount,
        lastViewedAt: row.lastViewedAt.toISOString(),
        profile,
      }] : [];
    });
    return this.pageResult(items, rows, input.pageSize, (row) => ({ timestamp: row.lastViewedAt.toISOString(), id: row.id }));
  }

  private async runAction<T extends Record<string, unknown>>(
    actorUserId: string,
    targetProfileId: string,
    action: SocialAction,
    idempotencyKey: string,
    operation: (tx: SocialTransaction, targetUserId: string, now: Date) => Promise<T>,
    options: { allowBlockCreation?: boolean } = {},
  ): Promise<T> {
    const keyHash = digest(this.idempotencySecret, "social-action", actorUserId, idempotencyKey);
    return this.withTargetPair(actorUserId, targetProfileId, async (tx, targetUserId, now) => {
      const [existing] = await tx.select().from(socialActionIdempotency).where(and(
        eq(socialActionIdempotency.actorUserId, actorUserId),
        eq(socialActionIdempotency.keyHash, keyHash),
      )).limit(1);
      if (existing) {
        if (existing.action !== action || existing.targetProfileId !== targetProfileId) {
          throw new Error("IDEMPOTENCY_CONFLICT");
        }
        return existing.response as T;
      }
      if (!options.allowBlockCreation) await this.assertAllowedInTransaction(tx, actorUserId, targetUserId);
      const response = await operation(tx, targetUserId, now);
      await tx.insert(socialActionIdempotency).values({
        actorUserId,
        keyHash,
        action,
        targetProfileId,
        response,
        createdAt: now,
      });
      return response;
    }, true);
  }

  private async withTargetPair<T>(
    actorUserId: string,
    targetProfileId: string,
    operation: (tx: SocialTransaction, targetUserId: string, now: Date) => Promise<T>,
    requireVisibleTarget: boolean,
  ) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as SocialTransaction;
      const [target] = await tx.select({ userId: profiles.userId }).from(profiles).where(and(
        eq(profiles.id, targetProfileId),
        requireVisibleTarget ? eq(profiles.status, "active") : undefined,
        requireVisibleTarget ? eq(profiles.discoverable, true) : undefined,
      )).limit(1);
      if (!target || target.userId === actorUserId) throw new Error("INTERACTION_NOT_ALLOWED");
      const pair = orderedPair(actorUserId, target.userId);
      const locked = await tx.select({ id: users.id }).from(users)
        .where(inArray(users.id, [pair.lowUserId, pair.highUserId]))
        .orderBy(asc(users.id)).for("update");
      if (locked.length !== 2) throw new Error("INTERACTION_NOT_ALLOWED");
      return operation(tx, target.userId, this.clock());
    });
  }

  private async assertAllowedInTransaction(tx: SocialTransaction, actorUserId: string, targetUserId: string) {
    const [block] = await tx.select({ id: userBlocks.id }).from(userBlocks).where(or(
      and(eq(userBlocks.blockerUserId, actorUserId), eq(userBlocks.blockedUserId, targetUserId)),
      and(eq(userBlocks.blockerUserId, targetUserId), eq(userBlocks.blockedUserId, actorUserId)),
    )).limit(1);
    if (block) throw new Error("INTERACTION_NOT_ALLOWED");
  }

  private pageResult<TItem, TRow>(
    items: TItem[],
    rows: TRow[],
    pageSize: number,
    cursorFor: (row: TRow) => Cursor,
  ) {
    const nextCursor = rows.length > pageSize
      ? encodeCursor(cursorFor(rows[pageSize - 1]!), this.cursorSecret)
      : null;
    return { items, nextCursor };
  }

  private async publicProfiles(userIds: string[]) {
    if (userIds.length === 0) return new Map<string, Record<string, unknown>>();
    const uniqueUserIds = [...new Set(userIds)];
    const now = this.clock();
    const [profileRows, photoRows, interestRows] = await Promise.all([
      this.database.select({ profile: profiles, preferences: profilePreferences, privacy: privacySettings })
        .from(profiles)
        .innerJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
        .innerJoin(privacySettings, eq(privacySettings.userId, profiles.userId))
        .where(and(
          inArray(profiles.userId, uniqueUserIds),
          eq(profiles.status, "active"),
          eq(profiles.discoverable, true),
        )),
      this.database.select().from(profilePhotos).where(and(
        inArray(profilePhotos.userId, uniqueUserIds),
        eq(profilePhotos.moderationStatus, "approved"),
        isNull(profilePhotos.userRemovedAt),
        isNull(profilePhotos.objectDeletedAt),
      )).orderBy(asc(profilePhotos.position), asc(profilePhotos.id)),
      this.database.select({ profileId: profileInterests.profileId, code: interests.code })
        .from(profileInterests)
        .innerJoin(interests, eq(profileInterests.interestId, interests.id))
        .where(inArray(profileInterests.profileId, this.database.select({ id: profiles.id })
          .from(profiles).where(inArray(profiles.userId, uniqueUserIds)))),
    ]);
    const photosByUser = Map.groupBy(photoRows, (photo) => photo.userId);
    const interestsByProfile = Map.groupBy(interestRows, (interest) => interest.profileId);
    return new Map(profileRows.flatMap(({ profile, preferences, privacy }) => {
      if (!profile.birthDate || (photosByUser.get(profile.userId) ?? []).length === 0) return [];
      const age = ageOn(profile.birthDate, now);
      return [[profile.userId, publicProfile({
        ...profile,
        age,
        ageBand: ageBand(age),
        languageCodes: preferences.languageCodes,
        interestCodes: (interestsByProfile.get(profile.id) ?? []).map(({ code }) => code),
        privacy,
        photos: photosByUser.get(profile.userId) ?? [],
      })] as const];
    }));
  }
}
