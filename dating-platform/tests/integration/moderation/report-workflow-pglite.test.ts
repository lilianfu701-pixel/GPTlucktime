// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { MessageRepository } from "@/modules/messaging/message-repository";
import { DrizzleReportRepository } from "@/modules/moderation/report-repository";
import { ReportService, RuleBasedReportRiskAssessor } from "@/modules/moderation/report-service";
import { DrizzleModerationContentPolicy } from "@/modules/moderation/content-policy";
import { DrizzleModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";
import { SocialRepository } from "@/modules/social/social-repository";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const CLIENT_ID = "00000000-0000-4000-8000-000000000101";

describe("report submission transaction", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let service: ReportService;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    service = new ReportService(new DrizzleReportRepository(database, {
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

  const addUser = async (name: string, countryCode = "US") => {
    const [user] = await database.insert(schema.users).values({
      name,
      email: `${name}@moderation.example`,
      emailVerified: true,
    }).returning();
    const [profile] = await database.insert(schema.profiles).values({
      userId: user.id,
      displayName: name,
      birthDate: "1990-01-01",
      genderCode: "person",
      relationshipGoalCode: "long_term",
      countryCode,
      city: "Seattle",
      timeZone: "UTC",
      status: "active",
      discoverable: true,
    }).returning();
    return { user, profile };
  };

  const addMessage = async (reporterUserId: string, targetUserId: string) => {
    const [lowUserId, highUserId] = [reporterUserId, targetUserId].sort();
    const [conversation] = await database.insert(schema.conversations).values({ lowUserId, highUserId }).returning();
    await database.insert(schema.conversationMembers).values([
      { conversationId: conversation.id, userId: lowUserId, lowUserId, highUserId },
      { conversationId: conversation.id, userId: highUserId, lowUserId, highUserId },
    ]);
    const [message] = await database.insert(schema.messages).values({
      conversationId: conversation.id,
      lowUserId,
      highUserId,
      sequence: 1,
      senderUserId: targetUserId,
      clientId: "00000000-0000-4000-8000-000000000301",
      body: "unsafe message that remains outside public report responses",
    }).returning();
    return { conversation, message };
  };

  it("freezes an authorized message target snapshot and returns only public fields", async () => {
    const reporter = await addUser("reporter");
    const target = await addUser("target");
    const { conversation, message } = await addMessage(reporter.user.id, target.user.id);

    const result = await service.submit(reporter.user.id, {
      clientId: CLIENT_ID,
      targetProfileId: target.profile.id,
      reason: "HARASSMENT",
      locale: "en-US",
      explanation: "unwanted contact",
      conversationId: conversation.id,
      messageId: message.id,
      evidenceReferences: [],
    });

    expect(Object.keys(result).sort()).toEqual(["createdAt", "duplicate", "id", "status"]);
    expect(result).toMatchObject({ status: "submitted", duplicate: false, createdAt: NOW.toISOString() });
    const [stored] = await database.select().from(schema.reports).where(eq(schema.reports.id, result.id));
    expect(stored?.targetSnapshot).toMatchObject({
      schemaVersion: 1,
      targetType: "message",
      targetUserId: target.user.id,
      targetProfileId: target.profile.id,
      messageId: message.id,
      conversationId: conversation.id,
      capturedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain(target.user.id);
    expect(JSON.stringify(result)).not.toContain(message.body);
  });

  it("uses a generic non-enumerating error for inaccessible or mismatched message targets", async () => {
    const reporter = await addUser("access-reporter");
    const target = await addUser("access-target");
    const outsider = await addUser("access-outsider");
    const { conversation, message } = await addMessage(reporter.user.id, target.user.id);

    await expect(service.submit(outsider.user.id, {
      clientId: CLIENT_ID,
      targetProfileId: target.profile.id,
      reason: "HARASSMENT",
      locale: "en",
      explanation: "cannot access",
      conversationId: conversation.id,
      messageId: message.id,
      evidenceReferences: [],
    })).rejects.toThrow("REPORT_NOT_AVAILABLE");

    await expect(service.submit(reporter.user.id, {
      clientId: CLIENT_ID,
      targetProfileId: outsider.profile.id,
      reason: "HARASSMENT",
      locale: "en",
      explanation: "message does not point to target",
      conversationId: conversation.id,
      messageId: message.id,
      evidenceReferences: [],
    })).rejects.toThrow("REPORT_NOT_AVAILABLE");
  });

  it("replays matching idempotency and suppresses concurrent semantic duplicates in the database", async () => {
    const reporter = await addUser("dedupe-reporter");
    const target = await addUser("dedupe-target");
    const base = {
      targetProfileId: target.profile.id,
      reason: "SPAM",
      locale: "en-US",
      explanation: "repeated messages",
      evidenceReferences: [],
    };
    const [first, duplicate] = await Promise.all([
      service.submit(reporter.user.id, { ...base, clientId: CLIENT_ID }),
      service.submit(reporter.user.id, {
        ...base,
        clientId: "00000000-0000-4000-8000-000000000102",
      }),
    ]);
    expect(duplicate.id).toBe(first.id);
    expect([first.duplicate, duplicate.duplicate].sort()).toEqual([false, true]);
    expect(await database.select().from(schema.reports)).toHaveLength(1);

    const replay = await service.submit(reporter.user.id, { ...base, clientId: CLIENT_ID });
    expect(replay).toEqual({ ...first, duplicate: true });
    await expect(service.submit(reporter.user.id, {
      ...base,
      clientId: CLIENT_ID,
      explanation: "different payload",
    })).rejects.toThrow("REPORT_IDEMPOTENCY_CONFLICT");
  });

  it("filters report history by owner in the database and returns only safe cursor pages", async () => {
    const owner = await addUser("history-owner");
    const other = await addUser("history-other");
    const target = await addUser("history-target");
    await service.submit(owner.user.id, {
      clientId: "00000000-0000-4000-8000-000000000111",
      targetProfileId: target.profile.id,
      reason: "HARASSMENT",
      locale: "en-US",
      explanation: "owner report",
      evidenceReferences: [],
    });
    await service.submit(other.user.id, {
      clientId: "00000000-0000-4000-8000-000000000112",
      targetProfileId: target.profile.id,
      reason: "SPAM",
      locale: "en-US",
      explanation: "other report",
      evidenceReferences: [],
    });
    const page = await service.listOwned(owner.user.id, { limit: 1 });
    expect(page.reports).toEqual([
      expect.objectContaining({ reason: "HARASSMENT", status: "submitted" }),
    ]);
    expect(JSON.stringify(page)).not.toMatch(/snapshot|evidence|targetUser|operator|confidence|caseId|workflow/iu);
  });

  it("creates restriction, quarantined evidence, alert and legal workflow atomically for emergency safety", async () => {
    const reporter = await addUser("safety-reporter");
    const target = await addUser("safety-target", "CA");
    const result = await service.submit(reporter.user.id, {
      clientId: CLIENT_ID,
      targetProfileId: target.profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-CA",
      explanation: "urgent safety concern",
      evidenceReferences: [{ type: "profile", id: target.profile.id }],
    });

    const [report] = await database.select().from(schema.reports).where(eq(schema.reports.id, result.id));
    const [moderationCase] = await database.select().from(schema.moderationCases)
      .where(eq(schema.moderationCases.reportId, result.id));
    expect(moderationCase).toMatchObject({ priority: "emergency", status: "triaged" });
    expect(await database.select().from(schema.userRestrictions)).toEqual([
      expect.objectContaining({ subjectUserId: target.user.id, scope: "all_interactions", active: true }),
    ]);
    expect(await database.select().from(schema.moderationEvidence)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reportId: report?.id,
        classification: "restricted_safety",
        quarantinedAt: NOW,
      }),
    ]));
    expect(await database.select().from(schema.safetyAlerts)).toHaveLength(1);
    expect(await database.select().from(schema.legalWorkflowTasks)).toEqual([
      expect.objectContaining({ jurisdictionCode: "CA", workflowCode: "minor-safety-review-v1" }),
    ]);
    expect(await database.select().from(schema.moderationOutboxEvents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "safety.alert.requested", status: "pending" }),
    ]));
    expect(await database.select().from(schema.moderationAuditEvents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorRole: "system", eventType: "emergency_triage_applied" }),
    ]));
  });

  it("makes an emergency restriction block the existing message send path", async () => {
    const reporter = await addUser("message-safety-reporter");
    const target = await addUser("message-safety-target");
    const { conversation, message } = await addMessage(reporter.user.id, target.user.id);
    await service.submit(reporter.user.id, {
      clientId: CLIENT_ID,
      targetProfileId: target.profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "urgent messaging safety concern",
      conversationId: conversation.id,
      messageId: message.id,
      evidenceReferences: [],
    });

    expect(await database.select().from(schema.moderationContentQuarantines)).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentType: "message", contentId: message.id, active: true }),
      expect.objectContaining({ contentType: "profile", contentId: target.profile.id, active: true }),
    ]));

    const contentPolicy = new DrizzleModerationContentPolicy();
    const repository = new MessageRepository(database, {
      interactionPolicy: new SocialRepository(database, {
        cursorSecret: "moderation-message-social-secret",
        idempotencySecret: "moderation-message-social-secret",
      }),
      entitlementService: {
        consumeInTransaction: async () => ({ allowed: true }),
        decideInTransaction: async () => ({ allowed: true }),
      } as never,
      verificationPolicy: { unmetInTransaction: async () => [] },
      restrictionPolicy: new DrizzleModerationRestrictionPolicy(),
      contentPolicy,
      cursorSecret: "message-moderation-test-secret",
      clock: () => NOW,
    });
    await expect(repository.sendMessage(target.user.id, conversation.id, {
      clientId: "00000000-0000-4000-8000-000000000399",
      body: "this must be denied by the moderation hold",
    })).rejects.toThrow("MESSAGE_SEND_DENIED");
    expect(await database.select().from(schema.messages)).toHaveLength(1);
    const additional = await database.insert(schema.messages).values([2, 3, 4].map((sequence) => ({
      conversationId: conversation.id,
      lowUserId: conversation.lowUserId,
      highUserId: conversation.highUserId,
      sequence,
      senderUserId: reporter.user.id,
      clientId: `00000000-0000-4000-8000-${String(sequence + 400).padStart(12, "0")}`,
      body: `history ${sequence}`,
    }))).returning();
    const [emergencyCase] = await database.select().from(schema.moderationCases);
    const [emergencyReport] = await database.select().from(schema.reports);
    await database.insert(schema.moderationContentQuarantines).values(additional.slice(0, 2).map((row) => ({
      caseId: emergencyCase!.id,
      reportId: emergencyReport!.id,
      contentType: "message",
      contentId: row.id,
      reasonCode: "EMERGENCY_SAFETY_QUARANTINE",
      startsAt: NOW,
      preserveUntil: new Date("2033-08-11T12:00:00.000Z"),
      createdAt: NOW,
    })));
    await expect(repository.listMessages(reporter.user.id, conversation.id, {
      afterSequence: 0,
      pageSize: 1,
    })).resolves.toMatchObject({ messages: [{ sequence: 4, body: "history 4" }] });
  });
});
