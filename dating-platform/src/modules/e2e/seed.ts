import { createHmac } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import {
  adminRoleAssignments,
  adminSessions,
  mediaReviewJobs,
  profilePhotos,
  profiles,
  users,
} from "@/db/schema";
import { db } from "@/infrastructure/db/client";
import { resetE2eDeliveries } from "@/modules/e2e/notification-adapter";
import { readEnv } from "@/shared/env";

const MODERATOR_EMAIL = "moderator.e2e@example.test";
const MODERATOR_TOKEN = "e2e_moderator_session_token_0000000000000001";

export async function resetE2eState() {
  await db.execute(sql`truncate table ${users} cascade`);
  resetE2eDeliveries();
  return seedE2eModerator();
}

export async function seedE2eModerator() {
  const env = readEnv(process.env);
  const [moderator] = await db.insert(users).values({
    name: "E2E Moderator",
    email: MODERATOR_EMAIL,
    emailVerified: true,
    phoneNumber: "+14155550999",
    phoneNumberVerified: true,
  }).onConflictDoUpdate({ target: users.email, set: { name: "E2E Moderator", emailVerified: true } })
    .returning({ id: users.id });
  const [assignment] = await db.insert(adminRoleAssignments).values({
    userId: moderator!.id,
    role: "moderation",
  }).returning({ id: adminRoleAssignments.id });
  await db.insert(adminSessions).values({
    userId: moderator!.id,
    roleAssignmentId: assignment!.id,
    tokenHash: createHmac("sha256", env.BETTER_AUTH_SECRET).update(MODERATOR_TOKEN).digest("hex"),
    mfaVerifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return { moderatorEmail: MODERATOR_EMAIL, adminCookie: MODERATOR_TOKEN };
}

export async function seedPendingPhoto(email: string) {
  const [owner] = await db.select({ userId: users.id, profileId: profiles.id })
    .from(users).innerJoin(profiles, eq(profiles.userId, users.id)).where(eq(users.email, email)).limit(1);
  if (!owner) throw new Error("E2E_MEMBER_PROFILE_NOT_FOUND");
  const objectKey = `e2e/${owner.userId}/profile-photo.jpg`;
  const [photo] = await db.insert(profilePhotos).values({
    userId: owner.userId,
    profileId: owner.profileId,
    objectKey,
    actualMimeType: "image/jpeg",
    actualSizeBytes: 1_024,
    width: 800,
    height: 800,
  }).onConflictDoNothing({ target: profilePhotos.objectKey }).returning({ id: profilePhotos.id });
  const existing = photo ?? (await db.select({ id: profilePhotos.id }).from(profilePhotos)
    .where(eq(profilePhotos.objectKey, objectKey)).limit(1))[0];
  if (!existing) throw new Error("E2E_PHOTO_NOT_CREATED");
  const [job] = await db.insert(mediaReviewJobs).values({
    userId: owner.userId,
    photoId: existing.id,
    objectKey,
  }).onConflictDoNothing({ target: mediaReviewJobs.photoId }).returning({ id: mediaReviewJobs.id });
  const existingJob = job ?? (await db.select({ id: mediaReviewJobs.id }).from(mediaReviewJobs)
    .where(eq(mediaReviewJobs.photoId, existing.id)).limit(1))[0];
  return { photoId: existing.id, jobId: existingJob!.id };
}
