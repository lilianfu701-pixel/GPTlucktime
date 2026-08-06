import { asc, eq, inArray } from "drizzle-orm";

import {
  interests,
  privacySettings,
  profileInterests,
  profilePreferences,
  profiles,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import type { ProfilePatch } from "./profile-schema";

type ProfileDatabase = typeof productionDatabase;

const requiredForCreate = ["displayName", "birthDate", "genderCode", "countryCode"] as const;

export class ProfileRepository {
  readonly database: ProfileDatabase;

  constructor(database: unknown) {
    this.database = database as ProfileDatabase;
  }

  async getForUser(userId: string) {
    return this.database.transaction((transaction) => this.read(transaction as unknown as ProfileDatabase, userId));
  }

  async upsertForUser(userId: string, patch: ProfilePatch) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as ProfileDatabase;
      const existing = await this.read(tx, userId);
      if (!existing && requiredForCreate.some((field) => patch[field] === undefined)) {
        throw new Error("PROFILE_INCOMPLETE");
      }

      const [profile] = existing
        ? await tx.update(profiles).set({
            ...(patch.displayName !== undefined && { displayName: patch.displayName }),
            ...(patch.birthDate !== undefined && { birthDate: patch.birthDate }),
            ...(patch.genderCode !== undefined && { genderCode: patch.genderCode }),
            ...(patch.relationshipGoalCode !== undefined && { relationshipGoalCode: patch.relationshipGoalCode }),
            ...(patch.countryCode !== undefined && { countryCode: patch.countryCode }),
            ...(patch.city !== undefined && { city: patch.city }),
            ...(patch.bio !== undefined && { bio: patch.bio }),
            ...(patch.discoverable !== undefined && { discoverable: patch.discoverable }),
            updatedAt: new Date(),
          }).where(eq(profiles.userId, userId)).returning()
        : await tx.insert(profiles).values({
            userId,
            displayName: patch.displayName!,
            birthDate: patch.birthDate!,
            genderCode: patch.genderCode!,
            relationshipGoalCode: patch.relationshipGoalCode,
            countryCode: patch.countryCode!,
            city: patch.city,
            bio: patch.bio,
            discoverable: patch.discoverable ?? true,
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
        updatedAt: new Date(),
      };
      await tx.insert(profilePreferences).values({ userId, ...preferenceValues }).onConflictDoUpdate({
        target: profilePreferences.userId,
        set: preferenceValues,
      });

      const existingPrivacy = existing?.privacy;
      const privacyValues = {
        showOnlineStatus: patch.privacy?.showOnlineStatus ?? existingPrivacy?.showOnlineStatus ?? true,
        showLastActive: patch.privacy?.showLastActive ?? existingPrivacy?.showLastActive ?? true,
        showProfileVisitors: patch.privacy?.showProfileVisitors ?? existingPrivacy?.showProfileVisitors ?? true,
        locationPrecision: patch.privacy?.locationPrecision ?? existingPrivacy?.locationPrecision ?? "city",
        updatedAt: new Date(),
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
      const result = await this.read(tx, userId);
      if (!result) throw new Error("PROFILE_WRITE_FAILED");
      return result;
    });
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
    return {
      ...profile,
      languageCodes: preferences?.languageCodes ?? [],
      interestCodes: interestRows.map(({ code }) => code),
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
