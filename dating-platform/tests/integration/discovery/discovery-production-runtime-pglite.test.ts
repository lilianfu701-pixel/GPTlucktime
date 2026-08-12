// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { publicDiscoveryFilterSchema } from "@/modules/discovery/discovery-types";
import { createProductionDiscoveryRepository } from "@/modules/discovery/runtime";
import { DrizzleReportRepository } from "@/modules/moderation/report-repository";
import { ReportService, RuleBasedReportRiskAssessor } from "@/modules/moderation/report-service";

const NOW = new Date("2026-08-11T12:00:00.000Z");

describe("production discovery composition used by SSR", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
  }, 30_000);

  afterEach(async () => client.close());

  const addPerson = async (name: string, genderCode: string) => {
    const [user] = await database.insert(schema.users).values({
      name,
      email: `${name}@production-discovery.test`,
    }).returning();
    const [profile] = await database.insert(schema.profiles).values({
      userId: user.id,
      displayName: name,
      birthDate: "1990-01-01",
      genderCode,
      relationshipGoalCode: "long_term",
      countryCode: "US",
      timeZone: "UTC",
      city: "Seattle",
      status: "active",
      discoverable: true,
      publishRequested: true,
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
    }).returning();
    await database.insert(schema.profilePreferences).values({
      userId: user.id,
      minimumAge: 18,
      maximumAge: 100,
      genderCodes: [],
      languageCodes: ["en"],
      relationshipGoalCodes: ["long_term"],
    });
    await database.insert(schema.privacySettings).values({ userId: user.id, locationPrecision: "country" });
    await database.insert(schema.profilePhotos).values({
      userId: user.id,
      profileId: profile.id,
      objectKey: `production-discovery/${profile.id}.jpg`,
      moderationStatus: "approved",
      position: 0,
      width: 800,
      height: 1000,
    });
    return { user, profile };
  };

  it("filters both official restrictions and active profile quarantines from the SSR repository", async () => {
    const viewer = await addPerson("runtime-viewer", "man");
    const restricted = await addPerson("runtime-restricted", "woman");
    const quarantined = await addPerson("runtime-quarantined", "woman");
    const service = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "production-discovery-moderation-secret",
      clock: () => NOW,
      jurisdictionPolicy: (countryCode) => ({
        jurisdictionCode: countryCode,
        workflowCode: "minor-safety-review-v1",
        dueAt: new Date(NOW.getTime() + 60 * 60_000),
      }),
    }), new RuleBasedReportRiskAssessor());
    const restrictedReport = await service.submit(viewer.user.id, {
      clientId: "00000000-0000-4000-8000-000000000911",
      targetProfileId: restricted.profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "restriction composition fixture",
      evidenceReferences: [],
    });
    const quarantinedReport = await service.submit(viewer.user.id, {
      clientId: "00000000-0000-4000-8000-000000000912",
      targetProfileId: quarantined.profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "quarantine composition fixture",
      evidenceReferences: [],
    });
    await database.update(schema.moderationContentQuarantines).set({ active: false, releasedAt: NOW })
      .where(and(
        eq(schema.moderationContentQuarantines.reportId, restrictedReport.id),
        eq(schema.moderationContentQuarantines.contentType, "profile"),
      ));
    await database.update(schema.userRestrictions).set({ active: false, revokedAt: NOW })
      .where(eq(schema.userRestrictions.sourceCaseId, (await database.select({
        id: schema.moderationCases.id,
      }).from(schema.moderationCases).where(eq(
        schema.moderationCases.reportId,
        quarantinedReport.id,
      )))[0]!.id));

    const repository = createProductionDiscoveryRepository(database, {
      cursorSecret: "production-discovery-cursor-secret",
      clock: () => NOW,
    });
    const result = await repository.discover(
      viewer.user.id,
      publicDiscoveryFilterSchema.parse({ mode: "recommended" }),
    );
    expect(result.items.map(({ id }) => id)).not.toContain(restricted.profile.id);
    expect(result.items.map(({ id }) => id)).not.toContain(quarantined.profile.id);
  });
});
