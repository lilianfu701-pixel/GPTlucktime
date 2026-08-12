// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleCaseService } from "@/modules/moderation/case-service";
import { DrizzleReportRepository } from "@/modules/moderation/report-repository";
import { ReportService, RuleBasedReportRiskAssessor } from "@/modules/moderation/report-service";

const NOW = new Date("2026-08-11T12:00:00.000Z");

describe("moderation case governance", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let caseService: DrizzleCaseService;
  let reportService: ReportService;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    caseService = new DrizzleCaseService(database, { clock: () => NOW });
    reportService = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "moderation-test-secret",
      clock: () => NOW,
      jurisdictionPolicy: (countryCode) => ({
        jurisdictionCode: countryCode,
        workflowCode: "minor-safety-review-v1",
        dueAt: new Date(NOW.getTime() + 60 * 60_000),
      }),
    }), new RuleBasedReportRiskAssessor());
  }, 30_000);

  afterEach(async () => client.close());

  const addUser = async (name: string) => {
    const [user] = await database.insert(schema.users).values({
      name,
      email: `${name}@case.example`,
      emailVerified: true,
    }).returning();
    const [profile] = await database.insert(schema.profiles).values({
      userId: user.id,
      displayName: name,
      birthDate: "1990-01-01",
      genderCode: "person",
      relationshipGoalCode: "long_term",
      countryCode: "US",
      city: "Seattle",
      timeZone: "UTC",
      status: "active",
      discoverable: true,
    }).returning();
    return { user, profile };
  };

  const createCase = async (reason: "HARASSMENT" | "MINOR_SAFETY" = "HARASSMENT") => {
    const reporter = await addUser(`reporter-${reason.toLowerCase()}`);
    const target = await addUser(`target-${reason.toLowerCase()}`);
    const report = await reportService.submit(reporter.user.id, {
      clientId: reason === "HARASSMENT"
        ? "00000000-0000-4000-8000-000000000401"
        : "00000000-0000-4000-8000-000000000402",
      targetProfileId: target.profile.id,
      reason,
      locale: "en-US",
      explanation: "case workflow fixture",
      evidenceReferences: [],
    });
    const [moderationCase] = await database.select().from(schema.moderationCases)
      .where(eq(schema.moderationCases.reportId, report.id));
    return { reporter, target, moderationCase };
  };

  it("allows only the assigned case worker to follow the exact state machine", async () => {
    const { moderationCase } = await createCase();
    const worker = await addUser("case-worker");
    const otherWorker = await addUser("other-worker");
    const admin = await addUser("ordinary-admin");

    await expect(caseService.transition(moderationCase.id, {
      userId: admin.user.id,
      role: "admin",
    }, "triaged")).rejects.toThrow("FORBIDDEN");
    await expect(caseService.transition(moderationCase.id, {
      userId: worker.user.id,
      role: "case_worker",
    }, "under_review")).rejects.toThrow("INVALID_CASE_TRANSITION");

    await expect(caseService.transition(moderationCase.id, {
      userId: worker.user.id,
      role: "case_worker",
    }, "triaged")).resolves.toMatchObject({ status: "triaged", assignedWorkerUserId: worker.user.id });
    await expect(database.select({ publicStatus: schema.reports.publicStatus }).from(schema.reports)
      .where(eq(schema.reports.id, moderationCase.reportId))).resolves.toEqual([{ publicStatus: "in_review" }]);
    await expect(caseService.transition(moderationCase.id, {
      userId: otherWorker.user.id,
      role: "case_worker",
    }, "under_review")).rejects.toThrow("FORBIDDEN");
    await expect(caseService.transition(moderationCase.id, {
      userId: worker.user.id,
      role: "case_worker",
    }, "under_review")).resolves.toMatchObject({ status: "under_review" });
    await expect(caseService.transition(moderationCase.id, {
      userId: worker.user.id,
      role: "case_worker",
    }, "dismissed", { finalDecisionSummary: "insufficient evidence" }))
      .resolves.toMatchObject({ status: "dismissed", finalDecisionSummary: "insufficient evidence" });
    await expect(database.select({ publicStatus: schema.reports.publicStatus }).from(schema.reports)
      .where(eq(schema.reports.id, moderationCase.reportId))).resolves.toEqual([{ publicStatus: "resolved" }]);
  });

  it("requires complete high-impact action authority and appends immutable action and audit rows", async () => {
    const { moderationCase, target } = await createCase();
    const worker = await addUser("action-worker");
    const actor = { userId: worker.user.id, role: "case_worker" as const };
    await caseService.transition(moderationCase.id, actor, "triaged");
    await caseService.transition(moderationCase.id, actor, "under_review");

    await expect(caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "ban",
      reasonCode: "CONFIRMED_ABUSE",
      evidenceSummary: "reviewed corroborating evidence",
      expiryPolicy: "indefinite_review",
      expiresAt: null,
    })).rejects.toThrow("INVALID_ACTION");

    const action = await caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "ban",
      reasonCode: "CONFIRMED_ABUSE",
      evidenceSummary: "reviewed corroborating evidence",
      expiryPolicy: "indefinite_review",
      expiresAt: new Date("9999-12-31T23:59:59.000Z"),
    });
    expect(action).toMatchObject({ operatorUserId: worker.user.id, subjectUserId: target.user.id });
    expect(await database.select().from(schema.moderationAuditEvents)
      .where(eq(schema.moderationAuditEvents.eventType, "action_recorded"))).toHaveLength(1);
    await expect(database.update(schema.moderationActions).set({ reasonCode: "REWRITTEN" })
      .where(eq(schema.moderationActions.id, action.id))).rejects.toThrow();
    const [audit] = await database.select().from(schema.moderationAuditEvents)
      .where(eq(schema.moderationAuditEvents.eventType, "action_recorded"));
    await expect(database.delete(schema.moderationAuditEvents)
      .where(eq(schema.moderationAuditEvents.id, audit!.id))).rejects.toThrow();
  });

  it("creates a distinct appeal review case and preserves the original final decision", async () => {
    const { moderationCase, target } = await createCase();
    const worker = await addUser("original-worker");
    const reviewer = await addUser("appeal-reviewer");
    const actor = { userId: worker.user.id, role: "case_worker" as const };
    await caseService.transition(moderationCase.id, actor, "triaged");
    await caseService.transition(moderationCase.id, actor, "under_review");
    await caseService.transition(moderationCase.id, actor, "actioned", {
      finalDecisionSummary: "temporary restriction upheld",
    });

    const appeal = await caseService.createAppeal(target.user.id, moderationCase.id, "please review independently");
    expect(appeal.reviewCaseId).not.toBe(moderationCase.id);
    await caseService.transition(appeal.reviewCaseId, {
      userId: reviewer.user.id,
      role: "appeal_reviewer",
    }, "triaged");
    await caseService.transition(appeal.reviewCaseId, {
      userId: reviewer.user.id,
      role: "appeal_reviewer",
    }, "under_review");
    await caseService.finalizeAppeal(appeal.id, {
      userId: reviewer.user.id,
      role: "appeal_reviewer",
    }, "overturned", "new evidence changed the result");

    const [original] = await database.select().from(schema.moderationCases)
      .where(eq(schema.moderationCases.id, moderationCase.id));
    const [review] = await database.select().from(schema.moderationCases)
      .where(eq(schema.moderationCases.id, appeal.reviewCaseId));
    expect(original).toMatchObject({ status: "actioned", finalDecisionSummary: "temporary restriction upheld" });
    expect(review).toMatchObject({ kind: "appeal", status: "actioned", originalCaseId: moderationCase.id });
  });

  it("lets only designated safety or legal roles read isolated evidence and logs each access", async () => {
    const { moderationCase } = await createCase("MINOR_SAFETY");
    const admin = await addUser("evidence-admin");
    const worker = await addUser("evidence-worker");
    const safety = await addUser("safety-specialist");

    await expect(caseService.readEvidence(moderationCase.id, {
      userId: admin.user.id,
      role: "admin",
    }, "case_review")).rejects.toThrow("FORBIDDEN");
    await expect(caseService.readEvidence(moderationCase.id, {
      userId: worker.user.id,
      role: "case_worker",
    }, "case_review")).rejects.toThrow("FORBIDDEN");
    const evidence = await caseService.readEvidence(moderationCase.id, {
      userId: safety.user.id,
      role: "safety_specialist",
    }, "child_safety_review");
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: "restricted_safety" }),
    ]));
    expect(await database.select().from(schema.moderationEvidenceAccess)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorUserId: safety.user.id, actorRole: "safety_specialist" }),
    ]));
  });
});
