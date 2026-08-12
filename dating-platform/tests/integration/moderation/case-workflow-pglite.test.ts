// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleCaseService } from "@/modules/moderation/case-service";
import { MessageRepository } from "@/modules/messaging/message-repository";
import { DrizzleReportRepository } from "@/modules/moderation/report-repository";
import { DrizzleModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";
import { allowAllContentPolicy } from "@/modules/moderation/content-policy";
import { SocialRepository } from "@/modules/social/social-repository";
import { ReportService, RuleBasedReportRiskAssessor } from "@/modules/moderation/report-service";
import { DrizzleMediaLegalHoldPolicy } from "@/modules/moderation/media-hold-policy";
import { unavailableMediaEvidencePreserver } from "@/modules/moderation/media-evidence-preserver";

const NOW = new Date("2026-08-11T12:00:00.000Z");

describe("moderation case governance", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let caseService: DrizzleCaseService;
  let reportService: ReportService;
  let trustedEvidenceRoles: Map<string, "case_worker" | "safety_specialist" | "legal_reviewer">;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    trustedEvidenceRoles = new Map();
    caseService = new DrizzleCaseService(database, {
      clock: () => NOW,
      resolveEvidenceReaderRole: async (userId) => trustedEvidenceRoles.get(userId) ?? null,
    });
    reportService = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "moderation-test-secret",
      mediaHoldPolicy: new DrizzleMediaLegalHoldPolicy(database as never),
      mediaEvidencePreserver: unavailableMediaEvidencePreserver,
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
    expect(await database.select().from(schema.userRestrictions)
      .where(eq(schema.userRestrictions.sourceCaseId, moderationCase.id))).toEqual([
      expect.objectContaining({
        subjectUserId: target.user.id,
        scope: "all_interactions",
        expiryPolicy: "indefinite_review",
        expiresAt: new Date("9999-12-31T23:59:59.000Z"),
        active: true,
      }),
    ]);
    expect(await database.select({ status: schema.profiles.status }).from(schema.profiles)
      .where(eq(schema.profiles.userId, target.user.id))).toEqual([{ status: "active" }]);
    const allowed = await new DrizzleModerationRestrictionPolicy().filterAllowedInTransaction(
      database,
      [target.user.id],
      "messaging",
      NOW,
    );
    expect(allowed.has(target.user.id)).toBe(false);
    expect(await database.select().from(schema.moderationAuditEvents)
      .where(eq(schema.moderationAuditEvents.eventType, "action_recorded"))).toHaveLength(1);
    await expect(database.update(schema.moderationActions).set({ reasonCode: "REWRITTEN" })
      .where(eq(schema.moderationActions.id, action.id))).rejects.toThrow();
    const [audit] = await database.select().from(schema.moderationAuditEvents)
      .where(eq(schema.moderationAuditEvents.eventType, "action_recorded"));
    await expect(database.delete(schema.moderationAuditEvents)
      .where(eq(schema.moderationAuditEvents.id, audit!.id))).rejects.toThrow();
  });

  it("enforces fixed action expiry and rejects ambiguous permanent-action windows", async () => {
    const { moderationCase, reporter, target } = await createCase();
    const worker = await addUser("temporary-action-worker");
    const actor = { userId: worker.user.id, role: "case_worker" as const };
    await caseService.transition(moderationCase.id, actor, "triaged");
    await caseService.transition(moderationCase.id, actor, "under_review");

    await expect(caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "temporary_restriction",
      reasonCode: "TEMPORARY_SAFETY_HOLD",
      evidenceSummary: "short review window",
      expiryPolicy: "indefinite_review",
      expiresAt: new Date("9999-12-31T23:59:59.000Z"),
    })).rejects.toThrow("INVALID_ACTION");

    const expiresAt = new Date(NOW.getTime() + 60 * 60_000);
    await caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "temporary_restriction",
      reasonCode: "TEMPORARY_SAFETY_HOLD",
      evidenceSummary: "short review window",
      expiryPolicy: "fixed",
      expiresAt,
    });
    const policy = new DrizzleModerationRestrictionPolicy();
    const during = await policy.filterAllowedInTransaction(database, [target.user.id], "discovery", NOW);
    const after = await policy.filterAllowedInTransaction(
      database,
      [target.user.id],
      "discovery",
      new Date(expiresAt.getTime() + 1),
    );
    expect(during.has(target.user.id)).toBe(false);
    expect(after.has(target.user.id)).toBe(true);
    expect(await database.select({ status: schema.profiles.status }).from(schema.profiles)
      .where(eq(schema.profiles.userId, target.user.id))).toEqual([{ status: "active" }]);

    const [lowUserId, highUserId] = [reporter.user.id, target.user.id].sort();
    const [conversation] = await database.insert(schema.conversations).values({ lowUserId, highUserId }).returning();
    await database.insert(schema.conversationMembers).values([
      { conversationId: conversation.id, userId: lowUserId, lowUserId, highUserId },
      { conversationId: conversation.id, userId: highUserId, lowUserId, highUserId },
    ]);
    const messageRepository = (clock: () => Date) => new MessageRepository(database, {
      interactionPolicy: new SocialRepository(database, {
        cursorSecret: "case-action-message-policy-secret",
        idempotencySecret: "case-action-message-policy-secret",
      }),
      entitlementService: {
        consumeInTransaction: async () => ({ allowed: true }),
        decideInTransaction: async () => ({ allowed: true }),
      } as never,
      verificationPolicy: { unmetInTransaction: async () => [] },
      restrictionPolicy: new DrizzleModerationRestrictionPolicy(),
      contentPolicy: allowAllContentPolicy,
      cursorSecret: "case-action-message-policy-secret",
      clock,
    });
    await expect(messageRepository(() => NOW).sendMessage(reporter.user.id, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000801",
      body: "blocked during worker restriction",
    })).rejects.toThrow("MESSAGE_SEND_DENIED");
    await expect(messageRepository(() => new Date(expiresAt.getTime() + 1)).sendMessage(
      reporter.user.id,
      conversation.id,
      { clientId: "00000000-0000-4000-8000-000000000802", body: "allowed after expiry" },
    )).resolves.toMatchObject({ body: "allowed after expiry" });
  });

  it("rolls back the action ledger if its enforcement projection cannot be written", async () => {
    const { moderationCase, target } = await createCase();
    const worker = await addUser("atomic-action-worker");
    const actor = { userId: worker.user.id, role: "case_worker" as const };
    await caseService.transition(moderationCase.id, actor, "triaged");
    await caseService.transition(moderationCase.id, actor, "under_review");
    await database.execute(sql`CREATE FUNCTION reject_test_restriction() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_ENFORCEMENT_WRITE_FAILED'; END; $$`);
    await database.execute(sql`CREATE TRIGGER reject_test_restriction
      BEFORE INSERT ON user_restrictions FOR EACH ROW EXECUTE FUNCTION reject_test_restriction()`);

    await expect(caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "suspend",
      reasonCode: "CONFIRMED_ABUSE",
      evidenceSummary: "must be atomic",
      expiryPolicy: "fixed",
      expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    })).rejects.toThrow();
    expect(await database.select().from(schema.moderationActions)
      .where(eq(schema.moderationActions.caseId, moderationCase.id))).toEqual([]);
  });

  it("materializes a targeted content quarantine and explicitly restores it with audit", async () => {
    const { moderationCase, target } = await createCase();
    const worker = await addUser("content-action-worker");
    const actor = { userId: worker.user.id, role: "case_worker" as const };
    await caseService.transition(moderationCase.id, actor, "triaged");
    await caseService.transition(moderationCase.id, actor, "under_review");
    const expiresAt = new Date(NOW.getTime() + 24 * 60 * 60_000);
    await caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "quarantine_content",
      reasonCode: "PROFILE_REVIEW",
      evidenceSummary: "specific profile requires review",
      expiryPolicy: "fixed",
      expiresAt,
      contentTarget: { type: "profile", id: target.profile.id },
    });
    expect(await database.select().from(schema.moderationContentQuarantines)).toEqual([
      expect.objectContaining({ contentType: "profile", contentId: target.profile.id, active: true }),
    ]);
    await caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "restore",
      reasonCode: "REVIEW_CLEARED",
      evidenceSummary: "review cleared specific enforcement projections",
      expiryPolicy: "fixed",
      expiresAt,
    });
    expect(await database.select({
      active: schema.moderationContentQuarantines.active,
      releasedAt: schema.moderationContentQuarantines.releasedAt,
    }).from(schema.moderationContentQuarantines)).toEqual([{ active: false, releasedAt: NOW }]);
    expect(await database.select().from(schema.moderationAuditEvents).where(eq(
      schema.moderationAuditEvents.eventType,
      "action_recorded",
    ))).toHaveLength(2);
  });

  it("quarantines only content owned by the case subject and bound to the report context", async () => {
    const reporter = await addUser("quarantine-owner-reporter");
    const target = await addUser("quarantine-owner-target");
    const other = await addUser("quarantine-owner-other");
    const [targetPhoto] = await database.insert(schema.profilePhotos).values({
      userId: target.user.id,
      profileId: target.profile.id,
      objectKey: "quarantine-owner/target.jpg",
      objectVersion: "target-version",
      objectEtag: "target-etag",
      position: 0,
      moderationStatus: "approved",
    }).returning();
    const [otherPhoto] = await database.insert(schema.profilePhotos).values({
      userId: other.user.id,
      profileId: other.profile.id,
      objectKey: "quarantine-owner/other.jpg",
      objectVersion: "other-version",
      objectEtag: "other-etag",
      position: 0,
      moderationStatus: "approved",
    }).returning();
    const report = await reportService.submit(reporter.user.id, {
      clientId: "00000000-0000-4000-8000-000000000581",
      targetProfileId: target.profile.id,
      reason: "HARASSMENT",
      locale: "en-US",
      explanation: "content ownership quarantine fixture",
      evidenceReferences: [{ type: "photo", id: targetPhoto.id }],
    });
    const [moderationCase] = await database.select().from(schema.moderationCases)
      .where(eq(schema.moderationCases.reportId, report.id));
    const worker = await addUser("quarantine-owner-worker");
    const actor = { userId: worker.user.id, role: "case_worker" as const };
    await caseService.transition(moderationCase.id, actor, "triaged");
    await caseService.transition(moderationCase.id, actor, "under_review");
    const action = (contentTarget: { type: "profile" | "message" | "photo"; id: string }) =>
      caseService.recordAction(moderationCase.id, actor, {
        subjectUserId: target.user.id,
        actionType: "quarantine_content",
        reasonCode: "CONTENT_OWNER_CHECK",
        evidenceSummary: "quarantine only case-bound subject content",
        expiryPolicy: "fixed",
        expiresAt: new Date(NOW.getTime() + 60_000),
        contentTarget,
      });
    const insertQuarantineDirectly = (contentType: "profile" | "message" | "photo", contentId: string) =>
      database.insert(schema.moderationContentQuarantines).values({
        caseId: moderationCase.id,
        reportId: report.id,
        contentType,
        contentId,
        reasonCode: "DIRECT_DATABASE_OWNERSHIP_CHECK",
        startsAt: NOW,
        preserveUntil: new Date(NOW.getTime() + 60_000),
        createdAt: NOW,
      });
    await expect(insertQuarantineDirectly("profile", other.profile.id))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining("MODERATION_RELATION_INVALID") } });
    await expect(insertQuarantineDirectly("photo", otherPhoto.id))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining("MODERATION_RELATION_INVALID") } });
    await expect(action({ type: "profile", id: other.profile.id })).rejects.toThrow("INVALID_ACTION");
    await expect(action({ type: "photo", id: otherPhoto.id })).rejects.toThrow("INVALID_ACTION");
    await expect(action({ type: "profile", id: target.profile.id })).resolves.toBeTruthy();
    await expect(action({ type: "photo", id: targetPhoto.id })).resolves.toBeTruthy();

    const [lowUserId, highUserId] = [reporter.user.id, target.user.id].sort();
    const [conversation] = await database.insert(schema.conversations).values({ lowUserId, highUserId }).returning();
    await database.insert(schema.conversationMembers).values([
      { conversationId: conversation.id, userId: lowUserId, lowUserId, highUserId },
      { conversationId: conversation.id, userId: highUserId, lowUserId, highUserId },
    ]);
    const [targetMessage, otherMessage] = await database.insert(schema.messages).values([
      {
        conversationId: conversation.id, lowUserId, highUserId, sequence: 1,
        senderUserId: target.user.id, clientId: "00000000-0000-4000-8000-000000000582", body: "case message",
      },
      {
        conversationId: conversation.id, lowUserId, highUserId, sequence: 2,
        senderUserId: reporter.user.id, clientId: "00000000-0000-4000-8000-000000000583", body: "other message",
      },
    ]).returning();
    await expect(insertQuarantineDirectly("message", targetMessage.id))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining("MODERATION_RELATION_INVALID") } });
    await expect(insertQuarantineDirectly("message", otherMessage.id))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining("MODERATION_RELATION_INVALID") } });
    await expect(action({ type: "message", id: targetMessage.id })).rejects.toThrow("INVALID_ACTION");
    await expect(action({ type: "message", id: otherMessage.id })).rejects.toThrow("INVALID_ACTION");

    const messageReport = await reportService.submit(reporter.user.id, {
      clientId: "00000000-0000-4000-8000-000000000584",
      targetProfileId: target.profile.id,
      conversationId: conversation.id,
      messageId: targetMessage.id,
      reason: "HARASSMENT",
      locale: "en-US",
      explanation: "message context quarantine fixture",
      evidenceReferences: [],
    });
    const [messageCase] = await database.select().from(schema.moderationCases)
      .where(eq(schema.moderationCases.reportId, messageReport.id));
    const messageWorker = await addUser("quarantine-message-worker");
    const messageActor = { userId: messageWorker.user.id, role: "case_worker" as const };
    await caseService.transition(messageCase.id, messageActor, "triaged");
    await caseService.transition(messageCase.id, messageActor, "under_review");
    await expect(caseService.recordAction(messageCase.id, messageActor, {
      subjectUserId: target.user.id,
      actionType: "quarantine_content",
      reasonCode: "MESSAGE_CONTEXT_CHECK",
      evidenceSummary: "valid subject-authored report message",
      expiryPolicy: "fixed",
      expiresAt: new Date(NOW.getTime() + 60_000),
      contentTarget: { type: "message", id: targetMessage.id },
    })).resolves.toBeTruthy();
  });

  it("creates a distinct appeal review case and preserves the original final decision", async () => {
    const { moderationCase, target } = await createCase();
    const worker = await addUser("original-worker");
    const reviewer = await addUser("appeal-reviewer");
    const actor = { userId: worker.user.id, role: "case_worker" as const };
    await caseService.transition(moderationCase.id, actor, "triaged");
    await caseService.transition(moderationCase.id, actor, "under_review");
    await caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "temporary_restriction",
      reasonCode: "APPEAL_FIXTURE_RESTRICTION",
      evidenceSummary: "original decision enforcement",
      expiryPolicy: "fixed",
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    });
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
    expect(await database.select({ status: schema.appeals.status }).from(schema.appeals)
      .where(eq(schema.appeals.id, appeal.id))).toEqual([{ status: "under_review" }]);
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
    expect(await database.select({ active: schema.userRestrictions.active }).from(schema.userRestrictions)
      .where(eq(schema.userRestrictions.sourceCaseId, moderationCase.id))).toEqual([{ active: false }]);
    expect(await database.select({ publicStatus: schema.reports.publicStatus }).from(schema.reports)
      .where(eq(schema.reports.id, moderationCase.reportId))).toEqual([{ publicStatus: "resolved" }]);
    expect(await database.select().from(schema.moderationAuditEvents).where(eq(
      schema.moderationAuditEvents.eventType,
      "appeal_enforcement_revoked",
    ))).toHaveLength(1);
  });

  it("materializes a modified appeal projection and audits both original and review cases", async () => {
    const { moderationCase, target } = await createCase();
    const worker = await addUser("modified-original-worker");
    const reviewer = await addUser("modified-appeal-reviewer");
    const actor = { userId: worker.user.id, role: "case_worker" as const };
    await caseService.transition(moderationCase.id, actor, "triaged");
    await caseService.transition(moderationCase.id, actor, "under_review");
    await caseService.recordAction(moderationCase.id, actor, {
      subjectUserId: target.user.id,
      actionType: "suspend",
      reasonCode: "MODIFIED_APPEAL_FIXTURE",
      evidenceSummary: "original longer restriction",
      expiryPolicy: "fixed",
      expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000),
    });
    await caseService.transition(moderationCase.id, actor, "actioned", {
      finalDecisionSummary: "original suspension",
    });
    const appeal = await caseService.createAppeal(target.user.id, moderationCase.id, "reduce the duration");
    const appealActor = { userId: reviewer.user.id, role: "appeal_reviewer" as const };
    await caseService.transition(appeal.reviewCaseId, appealActor, "triaged");
    await caseService.transition(appeal.reviewCaseId, appealActor, "under_review");
    const modifiedExpiry = new Date(NOW.getTime() + 12 * 60 * 60_000);
    await caseService.finalizeAppeal(
      appeal.id,
      appealActor,
      "modified",
      "restriction shortened after independent review",
      { restrictionExpiresAt: modifiedExpiry },
    );
    expect(await database.select({
      active: schema.userRestrictions.active,
      expiresAt: schema.userRestrictions.expiresAt,
    }).from(schema.userRestrictions).where(eq(
      schema.userRestrictions.sourceCaseId,
      moderationCase.id,
    ))).toEqual([{ active: true, expiresAt: modifiedExpiry }]);
    expect(await database.select({ publicStatus: schema.reports.publicStatus }).from(schema.reports)
      .where(eq(schema.reports.id, moderationCase.reportId))).toEqual([{ publicStatus: "resolved" }]);
    expect(await database.select({
      caseId: schema.moderationAuditEvents.caseId,
      eventType: schema.moderationAuditEvents.eventType,
    }).from(schema.moderationAuditEvents).where(eq(
      schema.moderationAuditEvents.eventType,
      "appeal_enforcement_modified",
    ))).toEqual([{ caseId: moderationCase.id, eventType: "appeal_enforcement_modified" }]);
    expect(await database.select().from(schema.moderationAuditEvents).where(eq(
      schema.moderationAuditEvents.eventType,
      "appeal_finalized",
    ))).toEqual([expect.objectContaining({ caseId: appeal.reviewCaseId })]);
  });

  it("lets only designated safety or legal roles read isolated evidence and logs each access", async () => {
    const { moderationCase } = await createCase("MINOR_SAFETY");
    const admin = await addUser("evidence-admin");
    const worker = await addUser("evidence-worker");
    const safety = await addUser("safety-specialist");
    const legal = await addUser("legal-reviewer");
    trustedEvidenceRoles.set(worker.user.id, "case_worker");
    trustedEvidenceRoles.set(safety.user.id, "safety_specialist");
    trustedEvidenceRoles.set(legal.user.id, "legal_reviewer");

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
    await expect(caseService.readEvidence(moderationCase.id, {
      userId: legal.user.id,
      role: "legal_reviewer",
    }, "legal_workflow_review")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: "restricted_safety" }),
    ]));
    await expect(caseService.readEvidence(moderationCase.id, {
      userId: admin.user.id,
      role: "safety_specialist",
    }, "forged_role")).rejects.toThrow("FORBIDDEN");
  });

  it("lets the assigned ordinary case worker read only integrity-verified evidence", async () => {
    const { moderationCase } = await createCase();
    const worker = await addUser("assigned-evidence-worker");
    trustedEvidenceRoles.set(worker.user.id, "case_worker");
    await caseService.transition(moderationCase.id, {
      userId: worker.user.id,
      role: "case_worker",
    }, "triaged");
    await expect(caseService.readEvidence(moderationCase.id, {
      userId: worker.user.id,
      role: "case_worker",
    }, "assigned_case_review")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: "ordinary" }),
    ]));
  });

  it("rejects evidence whose controlled snapshot binding does not match its integrity hash", async () => {
    const { moderationCase } = await createCase("MINOR_SAFETY");
    const safety = await addUser("integrity-safety-specialist");
    trustedEvidenceRoles.set(safety.user.id, "safety_specialist");
    await database.insert(schema.moderationEvidence).values({
      reportId: moderationCase.reportId,
      caseId: moderationCase.id,
      kind: "photo_reference",
      classification: "restricted_safety",
      locator: {
        schemaVersion: 1,
        referenceType: "photo",
        referenceId: "00000000-0000-4000-8000-000000000999",
      },
      integritySha256: "f".repeat(64),
      preserveUntil: new Date("2033-08-11T00:00:00.000Z"),
      quarantinedAt: NOW,
      createdAt: NOW,
    });
    await expect(caseService.readEvidence(moderationCase.id, {
      userId: safety.user.id,
      role: "safety_specialist",
    }, "integrity_review")).rejects.toThrow("EVIDENCE_NOT_AVAILABLE");
    expect(await database.select().from(schema.moderationEvidenceAccess)).toEqual([]);
  });

  it("rejects cross-row moderation relationships that do not bind to one report subject", async () => {
    const first = await createCase();
    const second = await createCase("MINOR_SAFETY");
    const operator = await addUser("relationship-guard-operator");
    const [photo] = await database.insert(schema.profilePhotos).values({
      profileId: first.target.profile.id,
      userId: first.target.user.id,
      objectKey: "relationship-guard/photo.jpg",
      position: 0,
      moderationStatus: "approved",
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();

    await expect(database.insert(schema.moderationActions).values({
      caseId: first.moderationCase.id,
      subjectUserId: second.target.user.id,
      actionType: "warn",
      reasonCode: "BAD_RELATION",
      evidenceSummary: "must not cross subjects",
      operatorUserId: operator.user.id,
      expiryPolicy: "fixed",
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    })).rejects.toThrow();
    await expect(database.insert(schema.moderationEvidence).values({
      reportId: second.moderationCase.reportId,
      caseId: first.moderationCase.id,
      kind: "profile_snapshot",
      classification: "ordinary",
      locator: {
        schemaVersion: 1,
        referenceType: "profile",
        referenceId: first.target.profile.id,
      },
      integritySha256: "a".repeat(64),
      preserveUntil: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    })).rejects.toThrow();
    await expect(database.insert(schema.moderationMediaHolds).values({
      reportId: first.moderationCase.reportId,
      caseId: first.moderationCase.id,
      subjectUserId: second.target.user.id,
      photoId: photo.id,
      objectKey: photo.objectKey,
      objectVersion: photo.updatedAt.toISOString(),
      snapshotSha256: "b".repeat(64),
      preserveUntil: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    })).rejects.toThrow();
  });

  it("protects immutable report facts, case identity and evidence content while allowing workflow updates", async () => {
    const first = await createCase();
    const second = await createCase("MINOR_SAFETY");
    const [evidence] = await database.select().from(schema.moderationEvidence)
      .where(eq(schema.moderationEvidence.caseId, first.moderationCase.id));

    await expect(database.update(schema.reports).set({ reasonCode: "SPAM" })
      .where(eq(schema.reports.id, first.moderationCase.reportId))).rejects.toThrow();
    await expect(database.delete(schema.reports)
      .where(eq(schema.reports.id, first.moderationCase.reportId))).rejects.toThrow();
    await expect(database.update(schema.moderationCases).set({ reportId: second.moderationCase.reportId })
      .where(eq(schema.moderationCases.id, first.moderationCase.id))).rejects.toThrow();
    await expect(database.update(schema.moderationEvidence).set({
      integritySha256: "0".repeat(64),
    }).where(eq(schema.moderationEvidence.id, evidence!.id))).rejects.toThrow();
    await expect(database.delete(schema.moderationEvidence)
      .where(eq(schema.moderationEvidence.id, evidence!.id))).rejects.toThrow();

    await expect(database.update(schema.reports).set({ publicStatus: "in_review", updatedAt: NOW })
      .where(eq(schema.reports.id, first.moderationCase.reportId))).resolves.toBeDefined();
    await expect(database.update(schema.moderationCases).set({
      assignedWorkerUserId: second.reporter.user.id,
      updatedAt: NOW,
    }).where(eq(schema.moderationCases.id, first.moderationCase.id))).resolves.toBeDefined();
  });
});
