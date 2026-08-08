import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  discoverySnapshotItems,
  discoverySnapshots,
  interests,
  privacySettings,
  profileInterests,
  profilePhotos,
  profilePreferences,
  profiles,
  savedSearches,
  sessions,
  userBlocks,
  users,
  verificationAttempts,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import { publicProfile } from "@/modules/profiles/profile-service";

import { ageOn, isCandidateEligible } from "./candidate-policy";
import {
  publicDiscoveryFilterSchema,
  savedDiscoveryFilterSchema,
  type DiscoveryFilters,
  type SavedDiscoveryFilters,
} from "./discovery-types";
import {
  decodeDiscoveryCursor,
  encodeDiscoveryCursor,
  filterFingerprint,
  rankCandidate,
  RANKING_VERSION,
} from "./ranking";

type DiscoveryDatabase = typeof productionDatabase;
type SnapshotItem = typeof discoverySnapshotItems.$inferSelect;
type RankedCandidate = {
  candidateUserId: string;
  profileId: string;
  score: number;
  createdAt: string;
  reasons: string[];
};

const SNAPSHOT_TTL_MS = 15 * 60_000;
const MAX_CANDIDATES_EVALUATED = 200;
const MAX_SNAPSHOT_ITEMS = 100;
const MAX_ACTIVE_SNAPSHOTS_PER_OWNER = 3;
const MAX_SNAPSHOT_ROWS_SCANNED = 50;
const SNAPSHOT_SCAN_BATCH = 50;
const ageBand = (age: number) => `${Math.floor(age / 5) * 5}-${Math.floor(age / 5) * 5 + 4}`;

export class DiscoveryRepository {
  private readonly database: DiscoveryDatabase;
  private readonly clock: () => Date;
  private readonly cursorSecret: string;
  private readonly disabledCountryCodes: ReadonlySet<string>;

  constructor(database: unknown, options: {
    clock?: () => Date;
    cursorSecret: string;
    disabledCountryCodes?: readonly string[];
  }) {
    this.database = database as DiscoveryDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.cursorSecret = options.cursorSecret;
    this.disabledCountryCodes = new Set(options.disabledCountryCodes ?? []);
  }

  async discover(userId: string, rawFilters: DiscoveryFilters) {
    const filters = publicDiscoveryFilterSchema.parse(rawFilters);
    const now = this.clock();
    const fingerprint = filterFingerprint(filters);
    await this.cleanupExpiredSnapshots(100, now);

    if (filters.cursor) {
      const cursor = decodeDiscoveryCursor(filters.cursor, this.cursorSecret, {
        rankingVersion: RANKING_VERSION,
        filterFingerprint: fingerprint,
      });
      if (new Date(cursor.expiresAt) <= now) throw new Error("INVALID_CURSOR");
      return this.readSnapshotPage({
        userId,
        filters,
        fingerprint,
        snapshotId: cursor.snapshotId,
        nextOrdinal: cursor.nextOrdinal,
        cursorExpiresAt: cursor.expiresAt,
        now,
      });
    }

    const snapshot = await this.createSnapshot(userId, filters, fingerprint, now);
    return this.readSnapshotPage({
      userId,
      filters,
      fingerprint,
      snapshotId: snapshot.id,
      nextOrdinal: 0,
      cursorExpiresAt: snapshot.expiresAt.toISOString(),
      now,
    });
  }

  async cleanupExpiredSnapshots(limit = 100, now = this.clock()) {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const expired = await this.database.select({ id: discoverySnapshots.id }).from(discoverySnapshots)
      .where(lte(discoverySnapshots.expiresAt, now)).orderBy(asc(discoverySnapshots.expiresAt))
      .limit(boundedLimit);
    if (expired.length === 0) return 0;
    await this.database.delete(discoverySnapshots).where(inArray(
      discoverySnapshots.id,
      expired.map(({ id }) => id),
    ));
    return expired.length;
  }

  private async createSnapshot(
    userId: string,
    filters: DiscoveryFilters,
    fingerprint: string,
    now: Date,
  ) {
    const reservation = await this.reserveSnapshot(userId, filters, fingerprint, now);
    if (reservation.status === "ready") return reservation;
    try {
      const materialized = await this.rankSnapshotCandidates(userId, filters, now);
      const snapshot = await this.database.transaction(async (transaction) => {
        const tx = transaction as unknown as DiscoveryDatabase;
        for (let offset = 0; offset < materialized.ranked.length; offset += 100) {
          const chunk = materialized.ranked.slice(offset, offset + 100);
          await tx.insert(discoverySnapshotItems).values(chunk.map((item, index) => ({
            snapshotId: reservation.id,
            ordinal: offset + index,
            candidateUserId: item.candidateUserId,
            candidateProfileId: item.profileId,
            score: item.score,
            reasons: item.reasons,
          })));
        }
        const [ready] = await tx.update(discoverySnapshots).set({
          status: "ready",
          itemCount: materialized.ranked.length,
          truncated: materialized.truncated,
        }).where(and(
          eq(discoverySnapshots.id, reservation.id),
          eq(discoverySnapshots.ownerUserId, userId),
          eq(discoverySnapshots.status, "building"),
        )).returning();
        if (!ready) throw new Error("DISCOVERY_SNAPSHOT_BUSY");
        return ready;
      });
      return snapshot;
    } catch (error) {
      await this.database.delete(discoverySnapshots).where(and(
        eq(discoverySnapshots.id, reservation.id),
        eq(discoverySnapshots.ownerUserId, userId),
        eq(discoverySnapshots.status, "building"),
      )).catch(() => undefined);
      throw error;
    }
  }

  private async reserveSnapshot(
    userId: string,
    filters: DiscoveryFilters,
    fingerprint: string,
    now: Date,
  ) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as DiscoveryDatabase;
      await tx.execute(sql`select ${users.id} from ${users} where ${users.id} = ${userId} for update`);
      await tx.delete(discoverySnapshots).where(and(
        eq(discoverySnapshots.ownerUserId, userId),
        lte(discoverySnapshots.expiresAt, now),
      ));
      const [existing] = await tx.select().from(discoverySnapshots).where(and(
        eq(discoverySnapshots.ownerUserId, userId),
        eq(discoverySnapshots.mode, filters.mode),
        eq(discoverySnapshots.filterFingerprint, fingerprint),
        eq(discoverySnapshots.rankingVersion, RANKING_VERSION),
        gt(discoverySnapshots.expiresAt, now),
      )).orderBy(desc(discoverySnapshots.createdAt), desc(discoverySnapshots.id)).limit(1);
      if (existing?.status === "ready") return existing;
      if (existing) throw new Error("DISCOVERY_SNAPSHOT_BUSY");

      const active = await tx.select({ id: discoverySnapshots.id, status: discoverySnapshots.status })
        .from(discoverySnapshots).where(and(
          eq(discoverySnapshots.ownerUserId, userId),
          gt(discoverySnapshots.expiresAt, now),
        )).orderBy(desc(discoverySnapshots.createdAt), desc(discoverySnapshots.id));
      const evictionCount = Math.max(0, active.length - MAX_ACTIVE_SNAPSHOTS_PER_OWNER + 1);
      if (evictionCount > 0) {
        const evictable = [...active].reverse().filter(({ status }) => status === "ready").slice(0, evictionCount);
        if (evictable.length !== evictionCount) throw new Error("DISCOVERY_SNAPSHOT_BUSY");
        await tx.delete(discoverySnapshots).where(inArray(
          discoverySnapshots.id,
          evictable.map(({ id }) => id),
        ));
      }
      const [created] = await tx.insert(discoverySnapshots).values({
        ownerUserId: userId,
        mode: filters.mode,
        filterFingerprint: fingerprint,
        rankingVersion: RANKING_VERSION,
        status: "building",
        itemCount: 0,
        truncated: false,
        expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS),
        createdAt: now,
      }).returning();
      return created!;
    });
  }

  private async rankSnapshotCandidates(
    userId: string,
    filters: DiscoveryFilters,
    now: Date,
  ) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as DiscoveryDatabase;
      const [viewerRow] = await tx.select({ profile: profiles, preferences: profilePreferences })
        .from(profiles)
        .innerJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
        .where(eq(profiles.userId, userId));
      if (!viewerRow?.profile.birthDate || !viewerRow.profile.genderCode || !viewerRow.profile.countryCode) {
        throw new Error("PROFILE_INCOMPLETE");
      }

      let ranked: RankedCandidate[] = [];
      let truncatedByEvaluation = false;
      if (!this.disabledCountryCodes.has(viewerRow.profile.countryCode)) {
        const viewerAge = ageOn(viewerRow.profile.birthDate, now);
        const baseWhere = and(
          ne(profiles.userId, userId),
          eq(profiles.status, "active"),
          eq(profiles.discoverable, true),
          lte(profiles.createdAt, now),
          isNotNull(profiles.birthDate),
          isNotNull(profiles.genderCode),
          isNotNull(profiles.countryCode),
          this.disabledCountryCodes.size > 0
            ? notInArray(profiles.countryCode, [...this.disabledCountryCodes])
            : undefined,
          viewerRow.preferences.genderCodes.length > 0
            ? inArray(profiles.genderCode, viewerRow.preferences.genderCodes)
            : undefined,
          viewerRow.preferences.preferredCountryCodes.length > 0
            ? inArray(profiles.countryCode, viewerRow.preferences.preferredCountryCodes)
            : undefined,
          sql`EXTRACT(YEAR FROM age(${now}, ${profiles.birthDate}))
            BETWEEN ${viewerRow.preferences.minimumAge} AND ${viewerRow.preferences.maximumAge}`,
          sql`EXTRACT(YEAR FROM age(${now}, ${profiles.birthDate}))
            BETWEEN ${filters.minimumAge} AND ${filters.maximumAge}`,
          filters.genderCodes.length > 0 ? inArray(profiles.genderCode, filters.genderCodes) : undefined,
          filters.countryCodes.length > 0 ? inArray(profiles.countryCode, filters.countryCodes) : undefined,
          filters.relationshipGoalCodes.length > 0
            ? inArray(profiles.relationshipGoalCode, filters.relationshipGoalCodes)
            : undefined,
          filters.languageCodes.length > 0
            ? sql`${profilePreferences.languageCodes} && ${filters.languageCodes}`
            : undefined,
          sql`${profilePreferences.minimumAge} <= ${viewerAge}
            AND ${profilePreferences.maximumAge} >= ${viewerAge}`,
          sql`(cardinality(${profilePreferences.genderCodes}) = 0
            OR ${viewerRow.profile.genderCode} = ANY(${profilePreferences.genderCodes}))`,
          sql`(cardinality(${profilePreferences.preferredCountryCodes}) = 0
            OR ${viewerRow.profile.countryCode} = ANY(${profilePreferences.preferredCountryCodes}))`,
          sql`EXISTS (
            SELECT 1 FROM ${profilePhotos} discovery_photo
            WHERE discovery_photo.profile_id = ${profiles.id}
              AND discovery_photo.moderation_status = 'approved'
              AND discovery_photo.user_removed_at IS NULL
              AND discovery_photo.object_deleted_at IS NULL
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${userBlocks} discovery_block
            WHERE (discovery_block.blocker_user_id = ${userId}
              AND discovery_block.blocked_user_id = ${profiles.userId})
              OR (discovery_block.blocked_user_id = ${userId}
                AND discovery_block.blocker_user_id = ${profiles.userId})
          )`,
          filters.mode === "nearby" ? eq(profiles.countryCode, viewerRow.profile.countryCode) : undefined,
          filters.mode === "online" ? and(
            eq(privacySettings.showOnlineStatus, true),
            sql`EXISTS (
              SELECT 1 FROM ${sessions} discovery_session
              WHERE discovery_session.user_id = ${profiles.userId}
                AND discovery_session.updated_at > ${new Date(now.getTime() - 15 * 60_000)}
                AND discovery_session.updated_at <= ${now}
                AND discovery_session.expires_at > ${now}
            )`,
          ) : undefined,
          filters.mode === "verified" ? sql`EXISTS (
            SELECT 1 FROM ${verificationAttempts} discovery_verification
            WHERE discovery_verification.user_id = ${profiles.userId}
              AND discovery_verification.kind = 'identity'
              AND discovery_verification.status = 'approved'
              AND discovery_verification.expires_at > ${now}
          )` : undefined,
        );
        const candidatePool = await tx.select({ id: profiles.id }).from(profiles)
          .innerJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
          .innerJoin(privacySettings, eq(privacySettings.userId, profiles.userId))
          .where(baseWhere)
          .orderBy(desc(profiles.createdAt), asc(profiles.id)).limit(MAX_CANDIDATES_EVALUATED + 1);
        truncatedByEvaluation = candidatePool.length > MAX_CANDIDATES_EVALUATED;
        const evaluatedProfileIds = candidatePool.slice(0, MAX_CANDIDATES_EVALUATED).map(({ id }) => id);
        const candidateRows = await tx.select({
          profile: profiles,
          preferences: profilePreferences,
          privacy: privacySettings,
        }).from(profiles)
          .innerJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
          .innerJoin(privacySettings, eq(privacySettings.userId, profiles.userId))
          .where(inArray(profiles.id, evaluatedProfileIds));

        if (candidateRows.length > 0) {
          const candidateUserIds = candidateRows.map(({ profile }) => profile.userId);
          const candidateProfileIds = candidateRows.map(({ profile }) => profile.id);
          const [photoRows, blockRows, interestRows, verifiedRows, onlineRows] = await Promise.all([
            tx.select().from(profilePhotos).where(and(
              inArray(profilePhotos.profileId, candidateProfileIds),
              eq(profilePhotos.moderationStatus, "approved"),
              isNull(profilePhotos.userRemovedAt),
              isNull(profilePhotos.objectDeletedAt),
            )).orderBy(asc(profilePhotos.position), asc(profilePhotos.id)),
            tx.select().from(userBlocks).where(or(
              and(eq(userBlocks.blockerUserId, userId), inArray(userBlocks.blockedUserId, candidateUserIds)),
              and(eq(userBlocks.blockedUserId, userId), inArray(userBlocks.blockerUserId, candidateUserIds)),
            )),
            tx.select({ profileId: profileInterests.profileId, code: interests.code })
              .from(profileInterests)
              .innerJoin(interests, eq(profileInterests.interestId, interests.id))
              .where(inArray(profileInterests.profileId, [viewerRow.profile.id, ...candidateProfileIds])),
            tx.select({ userId: verificationAttempts.userId }).from(verificationAttempts).where(and(
              inArray(verificationAttempts.userId, candidateUserIds),
              eq(verificationAttempts.kind, "identity"),
              eq(verificationAttempts.status, "approved"),
              gt(verificationAttempts.expiresAt, now),
            )),
            tx.select({ userId: sessions.userId }).from(sessions).where(and(
              inArray(sessions.userId, candidateUserIds),
              gt(sessions.updatedAt, new Date(now.getTime() - 15 * 60_000)),
              lte(sessions.updatedAt, now),
              gt(sessions.expiresAt, now),
            )),
          ]);
          const photosByProfile = Map.groupBy(photoRows, (photo) => photo.profileId);
          const interestsByProfile = Map.groupBy(interestRows, (interest) => interest.profileId);
          const viewerInterests = new Set(
            (interestsByProfile.get(viewerRow.profile.id) ?? []).map(({ code }) => code),
          );
          const verifiedUsers = new Set(verifiedRows.flatMap(({ userId: id }) => id ? [id] : []));
          const onlineUsers = new Set(onlineRows.map(({ userId: id }) => id));
          const outgoingBlocks = new Set(
            blockRows.filter((row) => row.blockerUserId === userId).map((row) => row.blockedUserId),
          );
          const incomingBlocks = new Set(
            blockRows.filter((row) => row.blockedUserId === userId).map((row) => row.blockerUserId),
          );
          const viewer = {
            userId,
            birthDate: viewerRow.profile.birthDate,
            genderCode: viewerRow.profile.genderCode,
            countryCode: viewerRow.profile.countryCode,
            status: viewerRow.profile.status,
            discoverable: viewerRow.profile.discoverable,
            approvedPhotoCount: 1,
            preferences: {
              minimumAge: viewerRow.preferences.minimumAge,
              maximumAge: viewerRow.preferences.maximumAge,
              genderCodes: viewerRow.preferences.genderCodes,
              preferredCountryCodes: viewerRow.preferences.preferredCountryCodes,
            },
          };

          ranked = candidateRows.flatMap(({ profile, preferences, privacy }): RankedCandidate[] => {
            if (!profile.birthDate || !profile.genderCode || !profile.countryCode) return [];
            const photos = photosByProfile.get(profile.id) ?? [];
            const candidate = {
              userId: profile.userId,
              birthDate: profile.birthDate,
              genderCode: profile.genderCode,
              countryCode: profile.countryCode,
              status: profile.status,
              discoverable: profile.discoverable,
              approvedPhotoCount: photos.length,
              preferences: {
                minimumAge: preferences.minimumAge,
                maximumAge: preferences.maximumAge,
                genderCodes: preferences.genderCodes,
                preferredCountryCodes: preferences.preferredCountryCodes,
              },
            };
            const eligible = isCandidateEligible({
              viewer,
              candidate,
              viewerBlockedCandidate: outgoingBlocks.has(profile.userId),
              candidateBlockedViewer: incomingBlocks.has(profile.userId),
              disabledRegion: this.disabledCountryCodes.has(profile.countryCode),
              now,
            });
            if (!eligible) return [];
            const candidateAge = ageOn(profile.birthDate, now);
            if (candidateAge < filters.minimumAge || candidateAge > filters.maximumAge) return [];
            if (filters.genderCodes.length && !filters.genderCodes.includes(profile.genderCode)) return [];
            if (filters.countryCodes.length && !filters.countryCodes.includes(profile.countryCode)) return [];
            if (filters.relationshipGoalCodes.length
              && (!profile.relationshipGoalCode
                || !filters.relationshipGoalCodes.includes(profile.relationshipGoalCode))) return [];
            if (filters.languageCodes.length
              && !filters.languageCodes.some((code) => preferences.languageCodes.includes(code))) return [];
            const isOnline = onlineUsers.has(profile.userId) && privacy.showOnlineStatus;
            const isVerified = verifiedUsers.has(profile.userId);
            if (filters.mode === "nearby" && profile.countryCode !== viewer.countryCode) return [];
            if (filters.mode === "online" && !isOnline) return [];
            if (filters.mode === "verified" && !isVerified) return [];
            const candidateInterests = (interestsByProfile.get(profile.id) ?? []).map(({ code }) => code);
            const sharedInterests = candidateInterests.filter((code) => viewerInterests.has(code));
            const score = rankCandidate({
              eligible: true,
              compatibilityScore: 50 + Math.min(10, sharedInterests.length * 2),
              activityScore: isOnline ? 10 : filters.mode === "new" ? 5 : 0,
              verificationScore: isVerified ? 10 : 0,
              boost: 0,
            });
            if (score === null) return [];
            return [{
              candidateUserId: profile.userId,
              profileId: profile.id,
              score,
              createdAt: profile.createdAt.toISOString(),
              reasons: [
                ...(sharedInterests.length ? ["shared_interests"] : []),
                ...(profile.countryCode === viewer.countryCode ? ["same_country"] : []),
                ...(isOnline ? ["recently_active"] : []),
                ...(isVerified ? ["identity_verified"] : []),
              ],
            }];
          });
        }
      }

      ranked.sort((left, right) => right.score - left.score
        || right.createdAt.localeCompare(left.createdAt)
        || left.profileId.localeCompare(right.profileId));
      return {
        ranked: ranked.slice(0, MAX_SNAPSHOT_ITEMS),
        truncated: truncatedByEvaluation || ranked.length > MAX_SNAPSHOT_ITEMS,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  private async readSnapshotPage(input: {
    userId: string;
    filters: DiscoveryFilters;
    fingerprint: string;
    snapshotId: string;
    nextOrdinal: number;
    cursorExpiresAt: string;
    now: Date;
  }) {
    const [snapshot] = await this.database.select().from(discoverySnapshots).where(and(
      eq(discoverySnapshots.id, input.snapshotId),
      eq(discoverySnapshots.ownerUserId, input.userId),
      eq(discoverySnapshots.mode, input.filters.mode),
      eq(discoverySnapshots.filterFingerprint, input.fingerprint),
      eq(discoverySnapshots.rankingVersion, RANKING_VERSION),
      eq(discoverySnapshots.status, "ready"),
      gt(discoverySnapshots.expiresAt, input.now),
    ));
    if (!snapshot || snapshot.expiresAt.toISOString() !== input.cursorExpiresAt) {
      throw new Error("INVALID_CURSOR");
    }

    const items: Array<Record<string, unknown>> = [];
    let scanOrdinal = input.nextOrdinal;
    let reachedEnd = false;
    let scannedRows = 0;
    while (items.length < input.filters.pageSize && !reachedEnd
      && scannedRows < Math.min(snapshot.itemCount, MAX_SNAPSHOT_ROWS_SCANNED)) {
      const batchLimit = Math.min(
        SNAPSHOT_SCAN_BATCH,
        MAX_SNAPSHOT_ROWS_SCANNED - scannedRows,
      );
      const rows = await this.database.select().from(discoverySnapshotItems).where(and(
        eq(discoverySnapshotItems.snapshotId, snapshot.id),
        gte(discoverySnapshotItems.ordinal, scanOrdinal),
      )).orderBy(asc(discoverySnapshotItems.ordinal)).limit(batchLimit);
      if (rows.length === 0) break;
      scannedRows += rows.length;
      const safe = await this.readCurrentlySafeCandidates(input.userId, rows, input.filters.mode, input.now);
      for (const row of rows) {
        scanOrdinal = row.ordinal + 1;
        const candidate = safe.get(row.candidateProfileId);
        if (candidate) items.push(candidate);
        if (items.length === input.filters.pageSize) break;
      }
      reachedEnd = rows.length < batchLimit;
    }

    const [remaining] = await this.database.select({ ordinal: discoverySnapshotItems.ordinal })
      .from(discoverySnapshotItems).where(and(
        eq(discoverySnapshotItems.snapshotId, snapshot.id),
        gte(discoverySnapshotItems.ordinal, scanOrdinal),
      )).orderBy(asc(discoverySnapshotItems.ordinal)).limit(1);
    const nextCursor = remaining ? encodeDiscoveryCursor({
      rankingVersion: RANKING_VERSION,
      filterFingerprint: input.fingerprint,
      snapshotId: snapshot.id,
      nextOrdinal: scanOrdinal,
      expiresAt: snapshot.expiresAt.toISOString(),
    }, this.cursorSecret) : null;
    return { items, nextCursor, rankingVersion: RANKING_VERSION, snapshotTruncated: snapshot.truncated };
  }

  private async readCurrentlySafeCandidates(
    userId: string,
    rows: SnapshotItem[],
    mode: DiscoveryFilters["mode"],
    now: Date,
  ) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as DiscoveryDatabase;
      const [viewerRow] = await tx.select({ profile: profiles, preferences: profilePreferences })
        .from(profiles).innerJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
        .where(eq(profiles.userId, userId));
      const viewer = viewerRow?.profile;
      if (!viewer?.birthDate || !viewer.genderCode || !viewer.countryCode || viewer.status !== "active"
        || this.disabledCountryCodes.has(viewer.countryCode)) return new Map<string, Record<string, unknown>>();
      const candidateProfileIds = rows.map(({ candidateProfileId }) => candidateProfileId);
      const candidateUserIds = rows.map(({ candidateUserId }) => candidateUserId);
      const [candidateRows, photoRows, blockRows, interestRows, verifiedRows, onlineRows] = await Promise.all([
        tx.select({ profile: profiles, preferences: profilePreferences, privacy: privacySettings })
          .from(profiles)
          .innerJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
          .innerJoin(privacySettings, eq(privacySettings.userId, profiles.userId))
          .where(inArray(profiles.id, candidateProfileIds)),
        tx.select().from(profilePhotos).where(and(
          inArray(profilePhotos.profileId, candidateProfileIds),
          eq(profilePhotos.moderationStatus, "approved"),
          isNull(profilePhotos.userRemovedAt),
          isNull(profilePhotos.objectDeletedAt),
        )).orderBy(asc(profilePhotos.position), asc(profilePhotos.id)),
        tx.select().from(userBlocks).where(or(
          and(eq(userBlocks.blockerUserId, userId), inArray(userBlocks.blockedUserId, candidateUserIds)),
          and(eq(userBlocks.blockedUserId, userId), inArray(userBlocks.blockerUserId, candidateUserIds)),
        )),
        tx.select({ profileId: profileInterests.profileId, code: interests.code })
          .from(profileInterests).innerJoin(interests, eq(profileInterests.interestId, interests.id))
          .where(inArray(profileInterests.profileId, candidateProfileIds)),
        tx.select({ userId: verificationAttempts.userId }).from(verificationAttempts).where(and(
          inArray(verificationAttempts.userId, candidateUserIds),
          eq(verificationAttempts.kind, "identity"),
          eq(verificationAttempts.status, "approved"),
          gt(verificationAttempts.expiresAt, now),
        )),
        tx.select({ userId: sessions.userId }).from(sessions).where(and(
          inArray(sessions.userId, candidateUserIds),
          gt(sessions.updatedAt, new Date(now.getTime() - 15 * 60_000)),
          lte(sessions.updatedAt, now),
          gt(sessions.expiresAt, now),
        )),
      ]);
      const photosByProfile = Map.groupBy(photoRows, (photo) => photo.profileId);
      const interestsByProfile = Map.groupBy(interestRows, (interest) => interest.profileId);
      const outgoingBlocks = new Set(
        blockRows.filter((block) => block.blockerUserId === userId).map((block) => block.blockedUserId),
      );
      const incomingBlocks = new Set(
        blockRows.filter((block) => block.blockedUserId === userId).map((block) => block.blockerUserId),
      );
      const verifiedUsers = new Set(verifiedRows.flatMap(({ userId: id }) => id ? [id] : []));
      const onlineUsers = new Set(onlineRows.map(({ userId: id }) => id));
      const snapshotItemsByProfile = new Map(rows.map((row) => [row.candidateProfileId, row]));
      const safe = new Map<string, Record<string, unknown>>();
      for (const { profile, preferences, privacy } of candidateRows) {
        const photos = photosByProfile.get(profile.id) ?? [];
        if (!profile.birthDate || !profile.genderCode || !profile.countryCode) continue;
        const eligible = isCandidateEligible({
          viewer: {
            userId,
            birthDate: viewer.birthDate,
            genderCode: viewer.genderCode,
            countryCode: viewer.countryCode,
            status: viewer.status,
            discoverable: viewer.discoverable,
            approvedPhotoCount: 1,
            preferences: {
              minimumAge: viewerRow.preferences.minimumAge,
              maximumAge: viewerRow.preferences.maximumAge,
              genderCodes: viewerRow.preferences.genderCodes,
              preferredCountryCodes: viewerRow.preferences.preferredCountryCodes,
            },
          },
          candidate: {
            userId: profile.userId,
            birthDate: profile.birthDate,
            genderCode: profile.genderCode,
            countryCode: profile.countryCode,
            status: profile.status,
            discoverable: profile.discoverable,
            approvedPhotoCount: photos.length,
            preferences: {
              minimumAge: preferences.minimumAge,
              maximumAge: preferences.maximumAge,
              genderCodes: preferences.genderCodes,
              preferredCountryCodes: preferences.preferredCountryCodes,
            },
          },
          viewerBlockedCandidate: outgoingBlocks.has(profile.userId),
          candidateBlockedViewer: incomingBlocks.has(profile.userId),
          disabledRegion: this.disabledCountryCodes.has(profile.countryCode),
          now,
        });
        if (!eligible) continue;
        const isOnline = onlineUsers.has(profile.userId) && privacy.showOnlineStatus;
        const isVerified = verifiedUsers.has(profile.userId);
        if (mode === "nearby" && profile.countryCode !== viewer.countryCode) continue;
        if (mode === "online" && !isOnline) continue;
        if (mode === "verified" && !isVerified) continue;
        const snapshotItem = snapshotItemsByProfile.get(profile.id);
        if (!snapshotItem) continue;
        const age = ageOn(profile.birthDate, now);
        const publicCandidate = publicProfile({
          ...profile,
          age,
          ageBand: ageBand(age),
          languageCodes: preferences.languageCodes,
          interestCodes: (interestsByProfile.get(profile.id) ?? []).map(({ code }) => code),
          privacy,
          photos,
        });
        publicCandidate.reasons = snapshotItem.reasons;
        safe.set(profile.id, publicCandidate);
      }
      return safe;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async listSavedSearches(userId: string) {
    return this.database.select().from(savedSearches).where(eq(savedSearches.userId, userId))
      .orderBy(desc(savedSearches.createdAt), asc(savedSearches.id));
  }

  async createSavedSearch(userId: string, name: string, input: unknown) {
    const filters = savedDiscoveryFilterSchema.parse(input) as SavedDiscoveryFilters;
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80) throw new Error("INVALID_SAVED_SEARCH");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as DiscoveryDatabase;
      await tx.execute(sql`select ${users.id} from ${users} where ${users.id} = ${userId} for update`);
      const [{ value }] = await tx.select({ value: count() }).from(savedSearches)
        .where(eq(savedSearches.userId, userId));
      if (Number(value) >= 20) throw new Error("SAVED_SEARCH_LIMIT");
      const [created] = await tx.insert(savedSearches).values({ userId, name: normalizedName, filters })
        .returning();
      return created!;
    });
  }

  async renameSavedSearch(userId: string, id: string, name: string) {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80) throw new Error("INVALID_SAVED_SEARCH");
    const [updated] = await this.database.update(savedSearches).set({ name: normalizedName, updatedAt: this.clock() })
      .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, userId))).returning();
    return updated ?? null;
  }

  async deleteSavedSearch(userId: string, id: string) {
    const deleted = await this.database.delete(savedSearches)
      .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, userId)))
      .returning({ id: savedSearches.id });
    return deleted.length > 0;
  }
}
