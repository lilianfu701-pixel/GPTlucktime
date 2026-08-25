// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { ModerationAcceptanceService } from "@/modules/moderation/acceptance-service";
import { DrizzleCaseService } from "@/modules/moderation/case-service";
import { DrizzleMediaLegalHoldPolicy } from "@/modules/moderation/media-hold-policy";
import { unavailableMediaEvidencePreserver } from "@/modules/moderation/media-evidence-preserver";
import { DrizzleReportRepository } from "@/modules/moderation/report-repository";
import { ReportService, RuleBasedReportRiskAssessor } from "@/modules/moderation/report-service";

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

  it("atomically starts appeal review and persistently replays the idempotent result", async () => {
    const cases = new DrizzleCaseService(database, { clock: () => NOW,
      resolveEvidenceReaderRole: async () => null });
    const reports = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "moderation-acceptance-secret", clock: () => NOW,
      mediaHoldPolicy: new DrizzleMediaLegalHoldPolicy(database as never),
      mediaEvidencePreserver: unavailableMediaEvidencePreserver,
      jurisdictionPolicy: (countryCode) => ({ jurisdictionCode: countryCode,
        workflowCode: "minor-safety-review-v1", dueAt: new Date(NOW.getTime() + 60_000) }),
    }), new RuleBasedReportRiskAssessor());
    const addMember = async (name: string) => {
      const [user] = await database.insert(schema.users).values({ name, email: `${name}@acceptance.example`,
        emailVerified: true }).returning();
      const [profile] = await database.insert(schema.profiles).values({ userId: user!.id, displayName: name,
        birthDate: "1990-01-01", genderCode: "person", relationshipGoalCode: "long_term", countryCode: "US",
        city: "Seattle", timeZone: "UTC", status: "active", discoverable: true }).returning();
      return { user: user!, profile: profile! };
    };
    const reviewer = await addMember("appeal-reviewer");
    const originalWorker = await addMember("original-worker");
    let sequence = 0;
    const createSubmittedAppeal = async () => {
      sequence += 1;
      const reporter = await addMember(`reporter-${sequence}`);
      const target = await addMember(`target-${sequence}`);
      const report = await reports.submit(reporter.user.id, { clientId: `00000000-0000-4000-8000-00000000040${sequence}`,
        targetProfileId: target.profile.id, reason: "HARASSMENT", locale: "en-US",
        explanation: "appeal acceptance fixture", evidenceReferences: [] });
      const [moderationCase] = await database.select().from(schema.moderationCases)
        .where(eq(schema.moderationCases.reportId, report.id));
      const worker = { userId: originalWorker.user.id, role: "case_worker" as const };
      await cases.transition(moderationCase!.id, worker, "triaged");
      await cases.transition(moderationCase!.id, worker, "under_review");
      await cases.transition(moderationCase!.id, worker, "dismissed", { finalDecisionSummary: "fixture closed" });
      return cases.createAppeal(target.user.id, moderationCase!.id, "please review this case");
    };
    const appeal = await createSubmittedAppeal();
    const otherAppeal = await createSubmittedAppeal();
    const service = new ModerationAcceptanceService(database as never, cases, {} as never,
      "h".repeat(32), () => NOW);
    const actor = { userId: reviewer.user.id, role: "moderation" as const, mfaVerifiedAt: NOW };
    const input = { idempotencyKey: "appeal-review-idempotency-1" };

    await client.exec(`CREATE FUNCTION reject_under_review() RETURNS trigger AS $$ BEGIN
      IF NEW.status = 'under_review' THEN RAISE EXCEPTION 'simulated second phase failure'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_under_review BEFORE UPDATE ON moderation_cases
      FOR EACH ROW EXECUTE FUNCTION reject_under_review();`);
    await expect(service.startAppealReview(actor, appeal.id, input)).rejects.toThrow("Failed query: update");
    expect(await database.select({ status: schema.moderationCases.status }).from(schema.moderationCases)
      .where(eq(schema.moderationCases.id, appeal.reviewCaseId))).toEqual([{ status: "submitted" }]);
    expect(await database.select().from(schema.moderationAuditEvents).where(and(
      eq(schema.moderationAuditEvents.caseId, appeal.reviewCaseId),
      eq(schema.moderationAuditEvents.eventType, "case_status_changed")))).toHaveLength(0);
    expect(await database.select().from(schema.adminActionIdempotency)).toHaveLength(0);

    await client.exec("DROP TRIGGER reject_under_review ON moderation_cases; DROP FUNCTION reject_under_review();");
    const first = await service.startAppealReview(actor, appeal.id, input);
    await expect(service.startAppealReview(actor, appeal.id, input)).resolves.toEqual(first);
    expect(await database.select().from(schema.moderationAuditEvents).where(and(
      eq(schema.moderationAuditEvents.caseId, appeal.reviewCaseId),
      eq(schema.moderationAuditEvents.eventType, "case_status_changed")))).toHaveLength(2);
    expect(await database.select().from(schema.adminActionIdempotency)).toHaveLength(1);
    await expect(service.startAppealReview(actor, otherAppeal.id, input)).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  }, 30_000);
});
