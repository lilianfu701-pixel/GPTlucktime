// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
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
import { DrizzleMediaLegalHoldPolicy } from "@/modules/moderation/media-hold-policy";
import { MediaReviewStore } from "@/modules/profiles/media-review-store";
import { cleanupRejectedMedia } from "@/workers/media-review-worker";
import { DrizzleCaseService } from "@/modules/moderation/case-service";
import type { MediaEvidencePreserver } from "@/modules/moderation/media-evidence-preserver";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const CLIENT_ID = "00000000-0000-4000-8000-000000000101";

describe("report submission transaction", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let service: ReportService;
  let holdPolicy: DrizzleMediaLegalHoldPolicy;
  const evidencePreserver: MediaEvidencePreserver = {
    preserve: async (source, destinationObjectKey) => ({
      objectKey: destinationObjectKey,
      objectVersion: `copy-${source.objectVersion}`,
      objectEtag: `copy-${source.objectEtag}`,
    }),
  };

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    holdPolicy = new DrizzleMediaLegalHoldPolicy(database as never);
    service = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "moderation-test-secret",
      clock: () => NOW,
      mediaHoldPolicy: holdPolicy,
      mediaEvidencePreserver: evidencePreserver,
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
    await expect(repository.listMessages(reporter.user.id, conversation.id, {
      afterSequence: 0,
      pageSize: 1,
    })).rejects.toThrow("CONVERSATION_NOT_AVAILABLE");
    await database.update(schema.userRestrictions).set({
      startsAt: sql`statement_timestamp() - interval '1 minute'`,
      expiresAt: sql`statement_timestamp() + interval '1 minute'`,
    }).where(eq(schema.userRestrictions.subjectUserId, target.user.id));
    await expect(database.insert(schema.messages).values({
      conversationId: conversation.id,
      lowUserId: conversation.lowUserId,
      highUserId: conversation.highUserId,
      sequence: 2,
      senderUserId: reporter.user.id,
      clientId: "00000000-0000-4000-8000-000000000398",
      body: "a forged historical timestamp must not bypass a current restriction",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    })).rejects.toThrow();
    await expect(database.insert(schema.messages).values([2, 3, 4].map((sequence) => ({
      conversationId: conversation.id,
      lowUserId: conversation.lowUserId,
      highUserId: conversation.highUserId,
      sequence,
      senderUserId: reporter.user.id,
      clientId: `00000000-0000-4000-8000-${String(sequence + 400).padStart(12, "0")}`,
      body: `history ${sequence}`,
    })))).rejects.toThrow();
  });

  it("holds referenced child-safety photo object through user removal and cleanup until explicit release", async () => {
    const reporter = await addUser("media-hold-reporter");
    const target = await addUser("media-hold-target");
    const [photo] = await database.insert(schema.profilePhotos).values({
      userId: target.user.id,
      profileId: target.profile.id,
      objectKey: `held/${target.profile.id}.jpg`,
      objectVersion: "provider-version-v7",
      objectEtag: "provider-etag-v7",
      moderationStatus: "approved",
      position: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
    await service.submit(reporter.user.id, {
      clientId: "00000000-0000-4000-8000-000000000777",
      targetProfileId: target.profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "preserve referenced child safety media",
      evidenceReferences: [{ type: "photo", id: photo.id }],
    });
    const [moderationCase] = await database.select().from(schema.moderationCases)
      .innerJoin(schema.reports, eq(schema.reports.id, schema.moderationCases.reportId))
      .where(eq(schema.reports.targetUserId, target.user.id))
      .then((rows) => rows.map((row) => row.moderation_cases));
    expect(await database.select().from(schema.moderationMediaHolds)).toEqual([
      expect.objectContaining({
        photoId: photo.id,
        objectKey: `restricted-evidence/${moderationCase.reportId}/${photo.id}`,
        objectVersion: "copy-provider-version-v7",
        active: true,
      }),
    ]);
    const store = new MediaReviewStore(database, { clock: () => NOW });
    await expect(store.markPhotoRemoved(target.user.id, photo.id)).resolves.toBe(true);
    const deleted: string[] = [];
    const storage = { deleteObject: async (key: string) => { deleted.push(key); } } as never;
    await expect(cleanupRejectedMedia({ store, storage, holdPolicy, clock: () => NOW })).resolves.toBe(0);
    expect(deleted).toEqual([]);
    const legal = await addUser("media-hold-legal-reviewer");
    const caseService = new DrizzleCaseService(database, {
      clock: () => NOW,
      resolveEvidenceReaderRole: async (userId) => userId === legal.user.id ? "legal_reviewer" : null,
    });
    await expect(caseService.readEvidence(moderationCase.id, {
      userId: legal.user.id,
      role: "legal_reviewer",
    }, "preserved_media_review")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: "restricted_safety" }),
    ]));
    await expect(caseService.releaseMediaHolds(moderationCase.id, {
      userId: reporter.user.id,
      role: "legal_reviewer",
    }, "forged legal release")).rejects.toThrow("FORBIDDEN");
    await expect(caseService.releaseMediaHolds(moderationCase.id, {
      userId: legal.user.id,
      role: "legal_reviewer",
    }, "retention review completed")).resolves.toEqual({ releasedCount: 1 });
    expect(await database.select().from(schema.moderationAuditEvents).where(eq(
      schema.moderationAuditEvents.eventType,
      "media_hold_released",
    ))).toEqual([expect.objectContaining({ actorUserId: legal.user.id })]);
    await expect(cleanupRejectedMedia({ store, storage, holdPolicy, clock: () => NOW })).resolves.toBe(1);
    expect(deleted).toEqual([photo.objectKey]);
  });

  it("rejects media copies and holds that do not match the report subject and immutable photo version", async () => {
    const reporter = await addUser("media-relation-reporter");
    const target = await addUser("media-relation-target");
    const other = await addUser("media-relation-other");
    const [targetPhoto] = await database.insert(schema.profilePhotos).values({
      userId: target.user.id,
      profileId: target.profile.id,
      objectKey: "media-relation/target.jpg",
      objectVersion: "target-source-version",
      objectEtag: "target-source-etag",
      moderationStatus: "approved",
      position: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
    const [otherPhoto] = await database.insert(schema.profilePhotos).values({
      userId: other.user.id,
      profileId: other.profile.id,
      objectKey: "media-relation/other.jpg",
      objectVersion: "other-source-version",
      objectEtag: "other-source-etag",
      moderationStatus: "approved",
      position: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
    const report = await service.submit(reporter.user.id, {
      clientId: "00000000-0000-4000-8000-000000000776",
      targetProfileId: target.profile.id,
      reason: "HARASSMENT",
      locale: "en-US",
      explanation: "media relation guard fixture",
      evidenceReferences: [{ type: "photo", id: targetPhoto.id }],
    });
    const [moderationCase] = await database.select().from(schema.moderationCases)
      .where(eq(schema.moderationCases.reportId, report.id));
    const copyValues = {
      reportId: report.id,
      caseId: moderationCase.id,
      subjectUserId: target.user.id,
      photoId: targetPhoto.id,
      sourceObjectKey: targetPhoto.objectKey,
      sourceObjectVersion: targetPhoto.objectVersion!,
      sourceObjectEtag: targetPhoto.objectEtag!,
      objectKey: `restricted-evidence/${report.id}/${targetPhoto.id}`,
      objectVersion: "restricted-copy-version",
      objectEtag: "restricted-copy-etag",
      createdAt: NOW,
    };
    await expect(database.insert(schema.moderationMediaCopies).values({
      ...copyValues,
      photoId: otherPhoto.id,
      sourceObjectKey: otherPhoto.objectKey,
      sourceObjectVersion: otherPhoto.objectVersion!,
      sourceObjectEtag: otherPhoto.objectEtag!,
      objectKey: `${copyValues.objectKey}-wrong-owner`,
    })).rejects.toMatchObject({ cause: { message: expect.stringContaining("MODERATION_RELATION_INVALID") } });
    await expect(database.insert(schema.moderationMediaCopies).values({
      ...copyValues,
      sourceObjectVersion: "forged-source-version",
    })).rejects.toMatchObject({ cause: { message: expect.stringContaining("MODERATION_RELATION_INVALID") } });
    const [copy] = await database.insert(schema.moderationMediaCopies).values(copyValues).returning();
    const holdValues = {
      reportId: report.id,
      caseId: moderationCase.id,
      subjectUserId: target.user.id,
      photoId: targetPhoto.id,
      evidenceCopyId: copy.id,
      objectKey: copy.objectKey,
      objectVersion: copy.objectVersion,
      snapshotSha256: "a".repeat(64),
      preserveUntil: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    };
    await expect(database.insert(schema.moderationMediaHolds).values({
      ...holdValues,
      objectVersion: "forged-copy-version",
    })).rejects.toMatchObject({ cause: { message: expect.stringContaining("MODERATION_RELATION_INVALID") } });
    await expect(database.insert(schema.moderationMediaHolds).values({
      ...holdValues,
      photoId: otherPhoto.id,
    })).rejects.toMatchObject({ cause: { message: expect.stringContaining("MODERATION_RELATION_INVALID") } });
    await expect(database.insert(schema.moderationMediaHolds).values(holdValues)).resolves.toBeTruthy();
  });

  it("revokes a paused cleanup claim when an emergency report establishes a hold", async () => {
    const reporter = await addUser("claim-race-reporter");
    const target = await addUser("claim-race-target");
    const [photo] = await database.insert(schema.profilePhotos).values({
      userId: target.user.id,
      profileId: target.profile.id,
      objectKey: `held/${target.profile.id}-claim-race.jpg`,
      objectVersion: "immutable-etag-claim-race",
      objectEtag: "immutable-content-etag-claim-race",
      moderationStatus: "approved",
      position: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
    const store = new MediaReviewStore(database, { clock: () => NOW });
    await store.markPhotoRemoved(target.user.id, photo.id);
    const coordinator = new DrizzleMediaLegalHoldPolicy(database as never);
    let claimReachedResolve!: () => void;
    let resumeClaimResolve!: () => void;
    const claimReached = new Promise<void>((resolve) => { claimReachedResolve = resolve; });
    const resumeClaim = new Promise<void>((resolve) => { resumeClaimResolve = resolve; });
    const pausedCoordinator: DrizzleMediaLegalHoldPolicy = Object.create(coordinator) as DrizzleMediaLegalHoldPolicy;
    pausedCoordinator.claimDeletion = async (...args) => {
      const claim = await coordinator.claimDeletion(...args);
      claimReachedResolve();
      await resumeClaim;
      return claim;
    };
    const deleted: string[] = [];
    const cleanup = cleanupRejectedMedia({
      store,
      storage: { deleteObject: async (key: string) => { deleted.push(key); } } as never,
      holdPolicy: pausedCoordinator,
      clock: () => NOW,
    });
    await claimReached;
    const raceService = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "claim-race-report-secret",
      clock: () => NOW,
      mediaHoldPolicy: coordinator,
      mediaEvidencePreserver: evidencePreserver,
      jurisdictionPolicy: (countryCode) => ({
        jurisdictionCode: countryCode,
        workflowCode: "minor-safety-review-v1",
        dueAt: new Date(NOW.getTime() + 60 * 60_000),
      }),
    }), new RuleBasedReportRiskAssessor());
    await raceService.submit(reporter.user.id, {
      clientId: "00000000-0000-4000-8000-000000000778",
      targetProfileId: target.profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "hold must invalidate a cleanup claim",
      evidenceReferences: [{ type: "photo", id: photo.id }],
    });
    resumeClaimResolve();
    await expect(cleanup).resolves.toBe(0);
    expect(deleted).toEqual([]);
    expect(await database.select().from(schema.moderationMediaHolds)).toEqual([
      expect.objectContaining({ photoId: photo.id, objectVersion: "copy-immutable-etag-claim-race", active: true }),
    ]);
  });

  it("keeps cleanup pending behind a report photo lock and skips after the hold commits", async () => {
    const reporter = await addUser("hold-lock-race-reporter");
    const target = await addUser("hold-lock-race-target");
    const [photo] = await database.insert(schema.profilePhotos).values({
      userId: target.user.id,
      profileId: target.profile.id,
      objectKey: `held/${target.profile.id}-hold-lock-race.jpg`,
      objectVersion: "immutable-etag-hold-lock-race",
      objectEtag: "immutable-content-etag-hold-lock-race",
      moderationStatus: "approved",
      position: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
    const store = new MediaReviewStore(database, { clock: () => NOW });
    await store.markPhotoRemoved(target.user.id, photo.id);
    const coordinator = new DrizzleMediaLegalHoldPolicy(database as never);
    let holdLockedResolve!: () => void;
    let resumeHoldResolve!: () => void;
    const holdLocked = new Promise<void>((resolve) => { holdLockedResolve = resolve; });
    const resumeHold = new Promise<void>((resolve) => { resumeHoldResolve = resolve; });
    const pausedCoordinator: DrizzleMediaLegalHoldPolicy = Object.create(coordinator) as DrizzleMediaLegalHoldPolicy;
    pausedCoordinator.prepareHoldInTransaction = async (...args) => {
      const source = await coordinator.prepareHoldInTransaction(...args);
      holdLockedResolve();
      await resumeHold;
      return source;
    };
    const raceService = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "hold-lock-race-report-secret",
      clock: () => NOW,
      mediaHoldPolicy: pausedCoordinator,
      mediaEvidencePreserver: evidencePreserver,
      jurisdictionPolicy: (countryCode) => ({
        jurisdictionCode: countryCode,
        workflowCode: "minor-safety-review-v1",
        dueAt: new Date(NOW.getTime() + 60 * 60_000),
      }),
    }), new RuleBasedReportRiskAssessor());
    const reporting = raceService.submit(reporter.user.id, {
      clientId: "00000000-0000-4000-8000-000000000779",
      targetProfileId: target.profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "cleanup must wait for the hold transaction",
      evidenceReferences: [{ type: "photo", id: photo.id }],
    });
    await holdLocked;
    const deleted: string[] = [];
    const cleanup = cleanupRejectedMedia({
      store,
      storage: { deleteObject: async (key: string) => { deleted.push(key); } } as never,
      holdPolicy: coordinator,
      clock: () => NOW,
    });
    expect(await Promise.race([
      cleanup.then(() => "finished" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ])).toBe("pending");
    resumeHoldResolve();
    await reporting;
    await expect(cleanup).resolves.toBe(0);
    expect(deleted).toEqual([]);
  });

  it("preserves an immutable evidence copy when report arrives after pre-delete validation", async () => {
    const reporter = await addUser("validated-delete-reporter");
    const target = await addUser("validated-delete-target");
    const [photo] = await database.insert(schema.profilePhotos).values({
      userId: target.user.id,
      profileId: target.profile.id,
      objectKey: `held/${target.profile.id}-validated-delete.jpg`,
      objectVersion: "source-version-before-delete",
      objectEtag: "source-etag-before-delete",
      moderationStatus: "approved",
      position: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
    const store = new MediaReviewStore(database, { clock: () => NOW });
    await store.markPhotoRemoved(target.user.id, photo.id);
    const coordinator = new DrizzleMediaLegalHoldPolicy(database as never);
    let validatedResolve!: () => void;
    let resumeDeleteResolve!: () => void;
    const validated = new Promise<void>((resolve) => { validatedResolve = resolve; });
    const resumeDelete = new Promise<void>((resolve) => { resumeDeleteResolve = resolve; });
    const pausedCoordinator: DrizzleMediaLegalHoldPolicy = Object.create(coordinator) as DrizzleMediaLegalHoldPolicy;
    pausedCoordinator.validateDeletionClaim = async (...args) => {
      const allowed = await coordinator.validateDeletionClaim(...args);
      validatedResolve();
      await resumeDelete;
      return allowed;
    };
    const deleted: string[] = [];
    const cleanup = cleanupRejectedMedia({
      store,
      storage: { deleteObject: async (key: string) => { deleted.push(key); } } as never,
      holdPolicy: pausedCoordinator,
      clock: () => NOW,
    });
    await validated;
    const raceService = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "validated-delete-report-secret",
      clock: () => NOW,
      mediaHoldPolicy: coordinator,
      mediaEvidencePreserver: evidencePreserver,
      jurisdictionPolicy: (countryCode) => ({
        jurisdictionCode: countryCode,
        workflowCode: "minor-safety-review-v1",
        dueAt: new Date(NOW.getTime() + 60 * 60_000),
      }),
    }), new RuleBasedReportRiskAssessor());
    const report = await raceService.submit(reporter.user.id, {
      clientId: "00000000-0000-4000-8000-000000000780",
      targetProfileId: target.profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "copy the immutable source version before original deletion",
      evidenceReferences: [{ type: "photo", id: photo.id }],
    });
    resumeDeleteResolve();
    await expect(cleanup).resolves.toBe(1);
    expect(deleted).toEqual([photo.objectKey]);
    const [copy] = await database.select().from(schema.moderationMediaCopies)
      .where(eq(schema.moderationMediaCopies.reportId, report.id));
    expect(copy).toMatchObject({
      sourceObjectKey: photo.objectKey,
      sourceObjectVersion: "source-version-before-delete",
      objectKey: `restricted-evidence/${report.id}/${photo.id}`,
      objectVersion: "copy-source-version-before-delete",
    });
    expect(await database.select().from(schema.moderationMediaHolds)).toEqual([
      expect.objectContaining({ evidenceCopyId: copy.id, objectKey: copy.objectKey, objectVersion: copy.objectVersion }),
    ]);
  });
});
