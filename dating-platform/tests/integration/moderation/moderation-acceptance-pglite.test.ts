// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { ModerationAcceptanceService } from "@/modules/moderation/acceptance-service";

const NOW = new Date("2026-08-24T12:00:00.000Z");

describe("moderation acceptance persistence", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  }, 30_000);
  afterEach(async () => client.close());

  it("manually decides a pending photo once and appends an immutable actor audit", async () => {
    const [actor, owner] = await database.insert(schema.users).values([
      { name: "Moderator", email: "moderator@example.test" },
      { name: "Member", email: "member@example.test" },
    ]).returning();
    const [profile] = await database.insert(schema.profiles).values({ userId: owner!.id }).returning();
    const [photo] = await database.insert(schema.profilePhotos).values({ userId: owner!.id, profileId: profile!.id,
      objectKey: "profile-review/member/photo.png", moderationStatus: "pending" }).returning();
    const [job] = await database.insert(schema.mediaReviewJobs).values({ userId: owner!.id, photoId: photo!.id,
      objectKey: photo!.objectKey, status: "pending", createdAt: NOW, updatedAt: NOW }).returning();
    const service = new ModerationAcceptanceService(database as never, {} as never, {} as never,
      "h".repeat(32), () => NOW);
    const adminActor = { userId: actor!.id, role: "moderation" as const, mfaVerifiedAt: NOW };
    const context = { requestId: "00000000-0000-4000-8000-000000000099", ipAddress: "203.0.113.8",
      idempotencyKey: "manual-photo-review-1" };

    await expect(service.decideMedia(adminActor, job!.id, "approved", "manual visual review completed", context))
      .resolves.toMatchObject({ status: "approved", replayed: false });
    await expect(service.decideMedia(adminActor, job!.id, "approved", "manual visual review completed", context))
      .resolves.toMatchObject({ status: "approved", replayed: true });
    expect((await database.select().from(schema.profilePhotos).where(eq(schema.profilePhotos.id, photo!.id)))[0])
      .toMatchObject({ moderationStatus: "approved", reviewProvider: "manual-admin" });
    expect(await database.select().from(schema.mediaReviewResults).where(eq(schema.mediaReviewResults.jobId, job!.id)))
      .toHaveLength(1);
    const audits = await database.select().from(schema.adminAuditLogs).where(eq(schema.adminAuditLogs.targetId, job!.id));
    expect(audits).toHaveLength(1);
    await expect(database.delete(schema.adminAuditLogs).where(eq(schema.adminAuditLogs.id, audits[0]!.id))).rejects.toThrow();
  }, 30_000);
});
