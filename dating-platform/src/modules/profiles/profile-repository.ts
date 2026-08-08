import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";

import {
  interests,
  privacySettings,
  profileInterests,
  profilePhotos,
  profilePreferences,
  profiles,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import type { ProfilePatch } from "./profile-schema";
import { assertAdult, calculateProfileCompleteness } from "./profile-service";

type ProfileDatabase = typeof productionDatabase;

export class ProfileRepository {
  readonly database: ProfileDatabase;
  private readonly clock: () => Date;

  constructor(database: unknown, options: { clock?: () => Date } = {}) {
    this.database = database as ProfileDatabase;
    this.clock = options.clock ?? (() => new Date());
  }

  async getForUser(userId: string) {
    return this.database.transaction((transaction) => this.read(transaction as unknown as ProfileDatabase, userId));
  }

  async upsertForUser(userId: string, patch: ProfilePatch) {
    let publishNotReady = false;
    const result = await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ProfileDatabase;
      const existing = await this.read(tx, userId);
      const now = this.clock();

      const [profile] = existing
        ? await tx.update(profiles).set({
            ...(patch.displayName !== undefined && { displayName: patch.displayName }),
            ...(patch.birthDate !== undefined && { birthDate: patch.birthDate }),
            ...(patch.genderCode !== undefined && { genderCode: patch.genderCode }),
            ...(patch.relationshipGoalCode !== undefined && { relationshipGoalCode: patch.relationshipGoalCode }),
            ...(patch.countryCode !== undefined && { countryCode: patch.countryCode }),
            ...(patch.timeZone !== undefined && { timeZone: patch.timeZone }),
            ...(patch.city !== undefined && { city: patch.city }),
            ...(patch.bio !== undefined && { bio: patch.bio }),
            updatedAt: now,
          }).where(eq(profiles.userId, userId)).returning()
        : await tx.insert(profiles).values({
            userId,
            displayName: patch.displayName,
            birthDate: patch.birthDate,
            genderCode: patch.genderCode,
            relationshipGoalCode: patch.relationshipGoalCode,
            countryCode: patch.countryCode,
            timeZone: patch.timeZone,
            city: patch.city,
            bio: patch.bio,
            discoverable: false,
            publishRequested: false,
            status: "draft",
          }).returning();

      const existingPreferences = existing?.preferences;
      const preferencePatch = patch.preferences;
      const languageCodes = patch.languageCodes
        ?? preferencePatch?.languageCodes
        ?? existingPreferences?.languageCodes
        ?? [];
      const preferenceValues = {
        genderCodes: preferencePatch?.genderCodes ?? existingPreferences?.genderCodes ?? [],
        minimumAge: preferencePatch?.minimumAge ?? existingPreferences?.minimumAge ?? 18,
        maximumAge: preferencePatch?.maximumAge ?? existingPreferences?.maximumAge ?? 100,
        preferredCountryCodes: preferencePatch?.preferredCountryCodes ?? existingPreferences?.preferredCountryCodes ?? [],
        languageCodes,
        relationshipGoalCodes: preferencePatch?.relationshipGoalCodes ?? existingPreferences?.relationshipGoalCodes ?? [],
        updatedAt: now,
      };
      if (preferenceValues.minimumAge > preferenceValues.maximumAge) throw new Error("INVALID_PROFILE");
      await tx.insert(profilePreferences).values({ userId, ...preferenceValues }).onConflictDoUpdate({
        target: profilePreferences.userId,
        set: preferenceValues,
      });

      const existingPrivacy = existing?.privacy;
      const privacyValues = {
        showOnlineStatus: patch.privacy?.showOnlineStatus ?? existingPrivacy?.showOnlineStatus ?? true,
        showLastActive: patch.privacy?.showLastActive ?? existingPrivacy?.showLastActive ?? true,
        showProfileVisitors: patch.privacy?.showProfileVisitors ?? existingPrivacy?.showProfileVisitors ?? true,
        locationPrecision: patch.privacy?.locationPrecision ?? existingPrivacy?.locationPrecision ?? "hidden",
        updatedAt: now,
      };
      await tx.insert(privacySettings).values({ userId, ...privacyValues }).onConflictDoUpdate({
        target: privacySettings.userId,
        set: privacyValues,
      });

      if (patch.interestCodes !== undefined) {
        await tx.delete(profileInterests).where(eq(profileInterests.profileId, profile.id));
        if (patch.interestCodes.length > 0) {
          await tx.insert(interests).values(
            patch.interestCodes.map((code) => ({ code, label: code })),
          ).onConflictDoNothing({ target: interests.code });
          const interestRows = await tx.select({ id: interests.id }).from(interests)
            .where(inArray(interests.code, patch.interestCodes));
          await tx.insert(profileInterests).values(
            interestRows.map((interest) => ({ profileId: profile.id, interestId: interest.id })),
          ).onConflictDoNothing();
        }
      }
      let merged = await this.read(tx, userId);
      if (!merged) throw new Error("PROFILE_WRITE_FAILED");
      if (merged.birthDate && merged.timeZone) assertAdult(merged.birthDate, now, merged.timeZone);
      const completeness = calculateProfileCompleteness(merged);
      const ready = completeness.percent === 100 && merged.approvedPhotoCount > 0;
      if (patch.publish === false) {
        await tx.update(profiles).set({
          status: "draft", discoverable: false, publishRequested: false, updatedAt: now,
        }).where(eq(profiles.userId, userId));
      } else if (patch.publish === true) {
        await tx.update(profiles).set({
          status: ready ? "active" : "draft",
          discoverable: ready,
          publishRequested: ready,
          updatedAt: now,
        }).where(eq(profiles.userId, userId));
        publishNotReady = !ready;
      } else if (merged.status === "active" && !ready) {
        await tx.update(profiles).set({
          status: "draft", discoverable: false, publishRequested: false, updatedAt: now,
        }).where(eq(profiles.userId, userId));
      }
      merged = await this.read(tx, userId);
      if (!merged) throw new Error("PROFILE_WRITE_FAILED");
      return merged;
    });
    if (publishNotReady) throw new Error("PROFILE_NOT_READY");
    return result;
  }

  private async read(database: ProfileDatabase, userId: string) {
    const [profile] = await database.select().from(profiles).where(eq(profiles.userId, userId));
    if (!profile) return null;
    const [preferences] = await database.select().from(profilePreferences)
      .where(eq(profilePreferences.userId, userId));
    const [privacy] = await database.select().from(privacySettings)
      .where(eq(privacySettings.userId, userId));
    const interestRows = await database.select({ code: interests.code })
      .from(profileInterests)
      .innerJoin(interests, eq(profileInterests.interestId, interests.id))
      .where(eq(profileInterests.profileId, profile.id))
      .orderBy(asc(interests.code));
    const [{ value: approvedPhotoCount }] = await database.select({ value: count() })
      .from(profilePhotos).where(and(
        eq(profilePhotos.profileId, profile.id),
        eq(profilePhotos.moderationStatus, "approved"),
        isNull(profilePhotos.userRemovedAt),
      ));
    const completeness = calculateProfileCompleteness({
      ...profile,
      languageCodes: preferences?.languageCodes ?? [],
      interestCodes: interestRows.map(({ code }) => code),
    });
    return {
      ...profile,
      languageCodes: preferences?.languageCodes ?? [],
      interestCodes: interestRows.map(({ code }) => code),
      approvedPhotoCount: Number(approvedPhotoCount),
      completeness,
      preferences: preferences ? {
        genderCodes: preferences.genderCodes,
        minimumAge: preferences.minimumAge,
        maximumAge: preferences.maximumAge,
        preferredCountryCodes: preferences.preferredCountryCodes,
        languageCodes: preferences.languageCodes,
        relationshipGoalCodes: preferences.relationshipGoalCodes,
      } : null,
      privacy: privacy ? {
        showOnlineStatus: privacy.showOnlineStatus,
        showLastActive: privacy.showLastActive,
        showProfileVisitors: privacy.showProfileVisitors,
        locationPrecision: privacy.locationPrecision,
      } : null,
    };
  }
}
