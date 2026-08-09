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
export type SocialTransaction = SocialDatabase;
type SocialAction = "like" | "favorite" | "view" | "block";
type PageInput = { pageSize: number; cursor?: string };
type LikesPageInput = PageInput & { direction: "sent" | "received" };
type Cursor = { timestamp: string; id: string };

const MAX_LIST_ROWS_SCANNED = 200;
const LIST_SCAN_BATCH = 50;
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

export interface InteractionPolicy {
  withAllowedInteraction<T>(
    actorUserId: string,
    targetUserId: string,
    write: (transaction: SocialTransaction) => Promise<T>,
  ): Promise<T>;
  withAllowedProfileInteraction<T>(
    actorUserId: string,
    targetProfileId: string,
    write: (transaction: SocialTransaction, targetUserId: string) => Promise<T>,
  ): Promise<T>;
  withSafeViewerRead<T>(
    viewerUserId: string,
    read: (transaction: SocialTransaction) => Promise<T>,
  ): Promise<T>;
  safeConversationProfilesInTransaction(
    transaction: SocialTransaction,
    viewerUserId: string,
    userIds: string[],
  ): Promise<Map<string, Record<string, unknown>>>;
  validateRealtimeTicket(actorUserId: string, targetUserId: string, issuedAt: Date): Promise<boolean>;
}

export class SocialRepository implements InteractionPolicy {
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

  async withAllowedInteraction<T>(
    actorUserId: string,
    targetUserId: string,
    write: (transaction: SocialTransaction) => Promise<T>,
  ) {
    if (actorUserId === targetUserId) throw new Error("INTERACTION_NOT_ALLOWED");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as SocialTransaction;
      await this.lockPairUsers(tx, actorUserId, targetUserId);
      await this.assertAllowedInTransaction(tx, actorUserId, targetUserId);
      return write(tx);
    });
  }

  async withAllowedProfileInteraction<T>(
    actorUserId: string,
    targetProfileId: string,
    write: (transaction: SocialTransaction, targetUserId: string) => Promise<T>,
  ) {
    return this.withTargetPair(actorUserId, targetProfileId, async (tx, targetUserId) => {
      await this.assertAllowedInTransaction(tx, actorUserId, targetUserId);
      return write(tx, targetUserId);
    }, true);
  }

  async withSafeViewerRead<T>(
    viewerUserId: string,
    read: (transaction: SocialTransaction) => Promise<T>,
  ) {
    return this.withViewerListTransaction(viewerUserId, read);
  }

  async safeConversationProfilesInTransaction(
    transaction: SocialTransaction,
    viewerUserId: string,
    userIds: string[],
  ) {
    return this.publicProfiles(transaction, viewerUserId, userIds, { requireDiscoverable: false });
  }

  async validateRealtimeTicket(actorUserId: string, targetUserId: string, issuedAt: Date) {
    if (Number.isNaN(issuedAt.getTime())) return false;
    try {
      return await this.withAllowedInteraction(actorUserId, targetUserId, async (tx) => {
        const pair = orderedPair(actorUserId, targetUserId);
        const [revocation] = await tx.select({ revokedBefore: realtimePairRevocations.revokedBefore })
          .from(realtimePairRevocations).where(and(
            eq(realtimePairRevocations.lowUserId, pair.lowUserId),
            eq(realtimePairRevocations.highUserId, pair.highUserId),
          )).limit(1);
        return !revocation || issuedAt.getTime() > revocation.revokedBefore.getTime();
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INTERACTION_NOT_ALLOWED") return false;
      throw error;
    }
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
      const pair = orderedPair(actorUserId, targetUserId);
      const [blockedMatch] = await tx.update(socialMatches)
        .set({ status: "blocked", hiddenAt: now, updatedAt: now }).where(and(
        eq(socialMatches.lowUserId, pair.lowUserId),
        eq(socialMatches.highUserId, pair.highUserId),
      )).returning({ id: socialMatches.id });
      if (blockedMatch) {
        await tx.update(socialOutboxEvents).set({
          status: "suppressed",
          suppressedAt: now,
          suppressionReason: "pair_blocked",
          leaseId: null,
          leaseExpiresAt: null,
          publishedAt: null,
        }).where(and(
          eq(socialOutboxEvents.eventType, "match.created"),
          eq(socialOutboxEvents.aggregateId, blockedMatch.id),
          inArray(socialOutboxEvents.status, ["pending", "failed", "processing"]),
        ));
      }
      await tx.update(socialLikes).set({ active: false, revokedAt: now, updatedAt: now }).where(or(
        and(eq(socialLikes.actorUserId, actorUserId), eq(socialLikes.targetUserId, targetUserId)),
        and(eq(socialLikes.actorUserId, targetUserId), eq(socialLikes.targetUserId, actorUserId)),
      ));
      await tx.delete(socialFavorites).where(or(
        and(eq(socialFavorites.ownerUserId, actorUserId), eq(socialFavorites.targetUserId, targetUserId)),
        and(eq(socialFavorites.ownerUserId, targetUserId), eq(socialFavorites.targetUserId, actorUserId)),
      ));
      if (inserted) {
        await tx.insert(realtimePairRevocations).values({ ...pair, revokedBefore: now, version: 1, updatedAt: now })
          .onConflictDoUpdate({
            target: [realtimePairRevocations.lowUserId, realtimePairRevocations.highUserId],
            set: {
              revokedBefore: now,
              version: sql`${realtimePairRevocations.version} + 1`,
              updatedAt: now,
            },
          });
      }
      return { blocked: true };
    }, { allowBlockCreation: true, requireVisibleTarget: false });
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
    return this.withViewerListTransaction(userId, async (tx) => {
      const otherUser = sql<string>`case when ${socialMatches.lowUserId} = ${userId}
        then ${socialMatches.highUserId} else ${socialMatches.lowUserId} end`;
      return this.scanSafeRows({
        tx,
        viewerUserId: userId,
        pageSize: input.pageSize,
        cursor,
        read: (after, limit) => tx.select({
          id: socialMatches.id,
          otherUserId: otherUser,
          createdAt: socialMatches.createdAt,
        }).from(socialMatches).where(and(
          eq(socialMatches.status, "active"),
          or(eq(socialMatches.lowUserId, userId), eq(socialMatches.highUserId, userId)),
          blockedSql(userId, otherUser),
          after ? or(
            lt(socialMatches.createdAt, new Date(after.timestamp)),
            and(eq(socialMatches.createdAt, new Date(after.timestamp)), gt(socialMatches.id, after.id)),
          ) : undefined,
        )).orderBy(desc(socialMatches.createdAt), asc(socialMatches.id)).limit(limit),
        cursorFor: (row) => ({ timestamp: row.createdAt.toISOString(), id: row.id }),
        itemFor: (row, profile) => ({ id: row.id, matchedAt: row.createdAt.toISOString(), profile }),
      });
    });
  }

  async listLikes(userId: string, input: LikesPageInput) {
    const cursor = decodeCursor(input.cursor, this.cursorSecret);
    return this.withViewerListTransaction(userId, async (tx) => {
      const ownerColumn = input.direction === "sent" ? socialLikes.actorUserId : socialLikes.targetUserId;
      const otherColumn = input.direction === "sent" ? socialLikes.targetUserId : socialLikes.actorUserId;
      return this.scanSafeRows({
        tx,
        viewerUserId: userId,
        pageSize: input.pageSize,
        cursor,
        read: (after, limit) => tx.select({
          id: socialLikes.id,
          otherUserId: otherColumn,
          createdAt: socialLikes.createdAt,
        }).from(socialLikes).where(and(
          eq(ownerColumn, userId),
          eq(socialLikes.active, true),
          blockedSql(userId, otherColumn),
          after ? or(
            lt(socialLikes.createdAt, new Date(after.timestamp)),
            and(eq(socialLikes.createdAt, new Date(after.timestamp)), gt(socialLikes.id, after.id)),
          ) : undefined,
        )).orderBy(desc(socialLikes.createdAt), asc(socialLikes.id)).limit(limit),
        cursorFor: (row) => ({ timestamp: row.createdAt.toISOString(), id: row.id }),
        itemFor: (row, profile) => ({ id: row.id, likedAt: row.createdAt.toISOString(), profile }),
      });
    });
  }

  async listFavorites(userId: string, input: PageInput) {
    const cursor = decodeCursor(input.cursor, this.cursorSecret);
    return this.withViewerListTransaction(userId, async (tx) => this.scanSafeRows({
      tx,
      viewerUserId: userId,
      pageSize: input.pageSize,
      cursor,
      read: (after, limit) => tx.select({
        id: socialFavorites.id,
        otherUserId: socialFavorites.targetUserId,
        createdAt: socialFavorites.createdAt,
      }).from(socialFavorites).where(and(
        eq(socialFavorites.ownerUserId, userId),
        blockedSql(userId, socialFavorites.targetUserId),
        after ? or(
          lt(socialFavorites.createdAt, new Date(after.timestamp)),
          and(eq(socialFavorites.createdAt, new Date(after.timestamp)), gt(socialFavorites.id, after.id)),
        ) : undefined,
      )).orderBy(desc(socialFavorites.createdAt), asc(socialFavorites.id)).limit(limit),
      cursorFor: (row) => ({ timestamp: row.createdAt.toISOString(), id: row.id }),
      itemFor: (row, profile) => ({ id: row.id, favoritedAt: row.createdAt.toISOString(), profile }),
    }));
  }

  async listVisitors(userId: string, input: PageInput) {
    const cursor = decodeCursor(input.cursor, this.cursorSecret);
    return this.withViewerListTransaction(userId, async (tx) => {
      const [ownerPrivacy] = await tx.select({ enabled: privacySettings.showProfileVisitors })
        .from(privacySettings).where(eq(privacySettings.userId, userId)).limit(1);
      if (!ownerPrivacy?.enabled) return { items: [], nextCursor: null };
      return this.scanSafeRows({
        tx,
        viewerUserId: userId,
        pageSize: input.pageSize,
        cursor,
        requireVisitorVisibility: true,
        read: (after, limit) => tx.select({
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
            after ? or(
              lt(profileViews.lastViewedAt, new Date(after.timestamp)),
              and(eq(profileViews.lastViewedAt, new Date(after.timestamp)), gt(profileViews.id, after.id)),
            ) : undefined,
          )).orderBy(desc(profileViews.lastViewedAt), asc(profileViews.id)).limit(limit),
        cursorFor: (row) => ({ timestamp: row.lastViewedAt.toISOString(), id: row.id }),
        itemFor: (row, profile) => ({
          id: row.id,
          viewCount: row.viewCount,
          lastViewedAt: row.lastViewedAt.toISOString(),
          profile,
        }),
      });
    });
  }

  private async runAction<T extends Record<string, unknown>>(
    actorUserId: string,
    targetProfileId: string,
    action: SocialAction,
    idempotencyKey: string,
    operation: (tx: SocialTransaction, targetUserId: string, now: Date) => Promise<T>,
    options: { allowBlockCreation?: boolean; requireVisibleTarget?: boolean } = {},
  ): Promise<T> {
    const keyHash = digest(this.idempotencySecret, "social-action", actorUserId, idempotencyKey);
    const [replay] = await this.database.select().from(socialActionIdempotency).where(and(
      eq(socialActionIdempotency.actorUserId, actorUserId),
      eq(socialActionIdempotency.keyHash, keyHash),
    )).limit(1);
    if (replay) {
      if (replay.action !== action || replay.targetProfileId !== targetProfileId) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return replay.response as T;
    }
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
    }, options.requireVisibleTarget ?? true);
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
      await this.lockPairUsers(tx, actorUserId, target.userId);
      return operation(tx, target.userId, this.clock());
    });
  }

  private async lockPairUsers(tx: SocialTransaction, leftUserId: string, rightUserId: string) {
    const pair = orderedPair(leftUserId, rightUserId);
    const locked = await tx.select({ id: users.id }).from(users)
      .where(inArray(users.id, [pair.lowUserId, pair.highUserId]))
      .orderBy(asc(users.id)).for("update");
    if (locked.length !== 2) throw new Error("INTERACTION_NOT_ALLOWED");
  }

  private async assertAllowedInTransaction(tx: SocialTransaction, actorUserId: string, targetUserId: string) {
    const activeProfiles = await tx.select({ userId: profiles.userId }).from(profiles).where(and(
      inArray(profiles.userId, [actorUserId, targetUserId]),
      eq(profiles.status, "active"),
    )).orderBy(asc(profiles.userId)).for("share");
    if (activeProfiles.length !== 2) throw new Error("INTERACTION_NOT_ALLOWED");
    const [block] = await tx.select({ id: userBlocks.id }).from(userBlocks).where(or(
      and(eq(userBlocks.blockerUserId, actorUserId), eq(userBlocks.blockedUserId, targetUserId)),
      and(eq(userBlocks.blockerUserId, targetUserId), eq(userBlocks.blockedUserId, actorUserId)),
    )).limit(1);
    if (block) throw new Error("INTERACTION_NOT_ALLOWED");
  }

  private async withViewerListTransaction<T>(
    viewerUserId: string,
    read: (transaction: SocialTransaction) => Promise<T>,
  ) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as SocialTransaction;
      const viewer = await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, viewerUserId)).for("share").limit(1);
      if (viewer.length !== 1) throw new Error("SOCIAL_VIEWER_NOT_FOUND");
      return read(tx);
    });
  }

  private async scanSafeRows<
    TRow extends { id: string; otherUserId: string },
    TItem,
  >(input: {
    tx: SocialTransaction;
    viewerUserId: string;
    pageSize: number;
    cursor: Cursor | null;
    requireVisitorVisibility?: boolean;
    read: (after: Cursor | null, limit: number) => Promise<TRow[]>;
    cursorFor: (row: TRow) => Cursor;
    itemFor: (row: TRow, profile: Record<string, unknown>) => TItem;
  }) {
    const items: TItem[] = [];
    let after = input.cursor;
    let scanned = 0;
    let hasMore = false;

    scan: while (items.length < input.pageSize && scanned < MAX_LIST_ROWS_SCANNED) {
      const limit = Math.min(LIST_SCAN_BATCH, MAX_LIST_ROWS_SCANNED - scanned);
      const rows = await input.read(after, limit);
      if (rows.length === 0) {
        hasMore = false;
        break;
      }
      const profilesByUser = await this.publicProfiles(
        input.tx,
        input.viewerUserId,
        rows.map(({ otherUserId }) => otherUserId),
        { requireVisitorVisibility: input.requireVisitorVisibility },
      );
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        scanned += 1;
        after = input.cursorFor(row);
        const profile = profilesByUser.get(row.otherUserId);
        if (profile) items.push(input.itemFor(row, profile));
        if (items.length === input.pageSize) {
          hasMore = index < rows.length - 1 || rows.length === limit;
          break scan;
        }
      }
      if (rows.length < limit) {
        hasMore = false;
        break;
      }
      hasMore = true;
    }

    return {
      items,
      nextCursor: hasMore && after ? encodeCursor(after, this.cursorSecret) : null,
    };
  }

  private async publicProfiles(
    database: SocialTransaction,
    viewerUserId: string,
    userIds: string[],
    options: { requireVisitorVisibility?: boolean; requireDiscoverable?: boolean } = {},
  ) {
    if (userIds.length === 0) return new Map<string, Record<string, unknown>>();
    const uniqueUserIds = [...new Set(userIds)];
    const now = this.clock();
    const [profileRows, photoRows, interestRows] = await Promise.all([
      database.select({ profile: profiles, preferences: profilePreferences, privacy: privacySettings })
        .from(profiles)
        .innerJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
        .innerJoin(privacySettings, eq(privacySettings.userId, profiles.userId))
        .where(and(
          inArray(profiles.userId, uniqueUserIds),
          eq(profiles.status, "active"),
          options.requireDiscoverable === false ? undefined : eq(profiles.discoverable, true),
          blockedSql(viewerUserId, profiles.userId),
          options.requireVisitorVisibility ? eq(privacySettings.showProfileVisitors, true) : undefined,
          sql`EXISTS (
            SELECT 1 FROM ${profilePhotos} social_safe_photo
            WHERE social_safe_photo.profile_id = ${profiles.id}
              AND social_safe_photo.moderation_status = 'approved'
              AND social_safe_photo.user_removed_at IS NULL
              AND social_safe_photo.object_deleted_at IS NULL
          )`,
        )),
      database.select().from(profilePhotos).where(and(
        inArray(profilePhotos.userId, uniqueUserIds),
        eq(profilePhotos.moderationStatus, "approved"),
        isNull(profilePhotos.userRemovedAt),
        isNull(profilePhotos.objectDeletedAt),
      )).orderBy(asc(profilePhotos.position), asc(profilePhotos.id)),
      database.select({ profileId: profileInterests.profileId, code: interests.code })
        .from(profileInterests)
        .innerJoin(interests, eq(profileInterests.interestId, interests.id))
        .where(inArray(profileInterests.profileId, database.select({ id: profiles.id })
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
