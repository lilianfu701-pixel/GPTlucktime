import { createHmac, timingSafeEqual } from "node:crypto";

import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import {
  conversationMembers,
  conversations,
  legalWorkflowTasks,
  messages,
  moderationAuditEvents,
  moderationCases,
  moderationContentQuarantines,
  moderationEvidence,
  moderationMediaHolds,
  moderationOutboxEvents,
  realtimePairRevocations,
  profilePhotos,
  profiles,
  reports,
  riskSignals,
  safetyAlerts,
  userRestrictions,
  users,
  type ControlledEvidenceLocator,
  type ModerationTargetSnapshot,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import {
  ModerationError,
  type PublicReport,
  type ReportSubmissionRepository,
  type SubmitReportInput,
} from "./report-service";
import { evidenceIntegritySha256 } from "./evidence-integrity";
import { mediaHoldSnapshotSha256 } from "./media-hold-integrity";

type ModerationDatabase = typeof productionDatabase;
type JurisdictionWorkflow = {
  jurisdictionCode: string;
  workflowCode: string;
  dueAt: Date;
};
type Cursor = { createdAt: string; id: string };

const canonical = (value: unknown) => JSON.stringify(value);
const dbErrorCode = (error: unknown) => (error as { code?: string; cause?: { code?: string } }).code
  ?? (error as { cause?: { code?: string } }).cause?.code;

const serializePublic = (row: typeof reports.$inferSelect, duplicate: boolean): PublicReport => ({
  id: row.id,
  status: row.publicStatus as PublicReport["status"],
  createdAt: row.createdAt.toISOString(),
  duplicate,
});

export class DrizzleReportRepository implements ReportSubmissionRepository {
  private readonly database: ModerationDatabase;
  private readonly idempotencySecret: string;
  private readonly clock: () => Date;
  private readonly jurisdictionPolicy: (countryCode: string) => JurisdictionWorkflow;

  constructor(database: unknown, options: {
    idempotencySecret: string;
    clock?: () => Date;
    jurisdictionPolicy: (countryCode: string) => JurisdictionWorkflow;
  }) {
    if (options.idempotencySecret.length < 16) throw new Error("MODERATION_IDEMPOTENCY_SECRET_TOO_SHORT");
    this.database = database as ModerationDatabase;
    this.idempotencySecret = options.idempotencySecret;
    this.clock = options.clock ?? (() => new Date());
    this.jurisdictionPolicy = options.jurisdictionPolicy;
  }

  async submit(input: Parameters<ReportSubmissionRepository["submit"]>[0]) {
    const requestHash = this.requestHash(input.report);
    const dedupeKey = this.dedupeKey(input.reporterUserId, input.report);
    const replay = await this.findByClient(input.reporterUserId, input.report.clientId);
    if (replay) return this.replay(replay, requestHash);
    const duplicate = await this.findByDedupe(dedupeKey);
    if (duplicate) return serializePublic(duplicate, true);

    try {
      return await this.database.transaction(async (transaction) => {
        const tx = transaction as unknown as ModerationDatabase;
        const lockedReplay = await this.findByClient(input.reporterUserId, input.report.clientId, tx);
        if (lockedReplay) return this.replay(lockedReplay, requestHash);
        const lockedDuplicate = await this.findByDedupe(dedupeKey, tx);
        if (lockedDuplicate) return serializePublic(lockedDuplicate, true);

        const [reporter] = await tx.select({ id: users.id }).from(users)
          .where(eq(users.id, input.reporterUserId)).limit(1);
        if (!reporter) {
          throw new ModerationError("REPORT_NOT_AVAILABLE");
        }
        const [target] = await tx.select({
          profileId: profiles.id,
          userId: profiles.userId,
          displayName: profiles.displayName,
          countryCode: profiles.countryCode,
        }).from(profiles).where(eq(profiles.id, input.report.targetProfileId)).limit(1);
        if (!target || target.userId === input.reporterUserId) {
          throw new ModerationError("REPORT_NOT_AVAILABLE");
        }
        await tx.select({ id: users.id }).from(users).where(or(
          eq(users.id, input.reporterUserId), eq(users.id, target.userId),
        )).orderBy(users.id).for("update");

        await this.authorizeReferences(tx, input.reporterUserId, target.userId, input.report);
        const now = this.clock();
        const targetType = input.report.messageId ? "message" as const : "profile" as const;
        const snapshot: ModerationTargetSnapshot = {
          schemaVersion: 1,
          targetType,
          targetUserId: target.userId,
          targetProfileId: target.profileId,
          displayName: target.displayName,
          capturedAt: now.toISOString(),
          messageId: input.report.messageId ?? null,
          conversationId: input.report.conversationId ?? null,
        };
        const [created] = await tx.insert(reports).values({
          reporterUserId: input.reporterUserId,
          targetUserId: target.userId,
          targetProfileId: target.profileId,
          targetType,
          messageId: input.report.messageId,
          conversationId: input.report.conversationId,
          reasonCode: input.report.reason,
          locale: input.report.locale,
          explanation: input.report.explanation,
          clientId: input.report.clientId,
          requestHash,
          dedupeKey,
          targetSnapshot: snapshot,
          createdAt: now,
          updatedAt: now,
        }).returning();
        const initialStatus = input.triage.priority === "emergency" ? "triaged" : "submitted";
        const [moderationCase] = await tx.insert(moderationCases).values({
          reportId: created.id,
          status: initialStatus,
          priority: input.triage.priority,
          createdAt: now,
          updatedAt: now,
        }).returning();
        await tx.insert(riskSignals).values({
          reportId: created.id,
          subjectUserId: target.userId,
          signalType: `report:${input.report.reason.toLowerCase()}`,
          confidenceBasisPoints: Math.round(input.confidence * 10_000),
          createdAt: now,
        });

        const emergency = input.triage.priority === "emergency";
        const preserveUntil = emergency
          ? new Date(Date.UTC(now.getUTCFullYear() + 7, now.getUTCMonth(), now.getUTCDate()))
          : new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
        const classification = emergency ? "restricted_safety" as const : "ordinary" as const;
        const evidence = this.evidenceLocators(input.report, target.profileId);
        await tx.insert(moderationEvidence).values(evidence.map(({ kind, locator }) => ({
          reportId: created.id,
          caseId: moderationCase.id,
          kind,
          classification,
          locator,
          integritySha256: evidenceIntegritySha256({
            reportId: created.id,
            caseId: moderationCase.id,
            subjectUserId: target.userId,
            targetSnapshot: snapshot,
            locator,
            capturedAt: now,
          }),
          preserveUntil,
          quarantinedAt: emergency ? now : null,
          createdAt: now,
        })));
        if (emergency) {
          const referencedPhotoIds = input.report.evidenceReferences
            .filter((reference) => reference.type === "photo")
            .map(({ id }) => id);
          if (referencedPhotoIds.length > 0) {
            const heldPhotos = await tx.select({
              id: profilePhotos.id,
              userId: profilePhotos.userId,
              objectKey: profilePhotos.objectKey,
              reviewVersion: profilePhotos.reviewVersion,
              updatedAt: profilePhotos.updatedAt,
            }).from(profilePhotos).where(and(
              eq(profilePhotos.profileId, target.profileId),
              or(...referencedPhotoIds.map((id) => eq(profilePhotos.id, id))),
            ));
            if (heldPhotos.length !== new Set(referencedPhotoIds).size) {
              throw new ModerationError("REPORT_NOT_AVAILABLE");
            }
            await tx.insert(moderationMediaHolds).values(heldPhotos.map((photo) => {
              const objectVersion = photo.reviewVersion ?? photo.updatedAt.toISOString();
              return {
                reportId: created.id,
                caseId: moderationCase.id,
                subjectUserId: photo.userId,
                photoId: photo.id,
                objectKey: photo.objectKey,
                objectVersion,
                snapshotSha256: mediaHoldSnapshotSha256({
                  reportId: created.id,
                  caseId: moderationCase.id,
                  subjectUserId: photo.userId,
                  photoId: photo.id,
                  objectKey: photo.objectKey,
                  objectVersion,
                  preserveUntil,
                }),
                preserveUntil,
                createdAt: now,
              };
            }));
          }
        }

        await tx.insert(moderationAuditEvents).values({
          caseId: moderationCase.id,
          actorRole: "system",
          eventType: emergency ? "emergency_triage_applied" : "report_submitted",
          summary: { priority: input.triage.priority, reasonCode: input.report.reason },
          createdAt: now,
        });

        if (emergency) {
          await tx.insert(moderationContentQuarantines).values([
            {
              caseId: moderationCase.id,
              reportId: created.id,
              contentType: "profile",
              contentId: target.profileId,
              reasonCode: "EMERGENCY_SAFETY_QUARANTINE",
              startsAt: now,
              preserveUntil,
              createdAt: now,
            },
            ...(input.report.messageId ? [{
              caseId: moderationCase.id,
              reportId: created.id,
              contentType: "message",
              contentId: input.report.messageId,
              reasonCode: "EMERGENCY_SAFETY_QUARANTINE",
              startsAt: now,
              preserveUntil,
              createdAt: now,
            }] : []),
          ]);
          const restrictionExpiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
          await tx.insert(userRestrictions).values({
            subjectUserId: target.userId,
            sourceCaseId: moderationCase.id,
            scope: "all_interactions",
            reasonCode: "AUTOMATED_EMERGENCY_SAFETY_HOLD",
            startsAt: now,
            expiresAt: restrictionExpiresAt,
            createdAt: now,
          });
          const subjectPairs = await tx.select({
            lowUserId: conversations.lowUserId,
            highUserId: conversations.highUserId,
          }).from(conversations).where(or(
            eq(conversations.lowUserId, target.userId), eq(conversations.highUserId, target.userId),
          ));
          for (const pair of subjectPairs) await tx.insert(realtimePairRevocations).values({
            ...pair, version: 1, revokedBefore: now, updatedAt: now,
          }).onConflictDoUpdate({
            target: [realtimePairRevocations.lowUserId, realtimePairRevocations.highUserId],
            set: { version: sql`${realtimePairRevocations.version} + 1`, revokedBefore: now, updatedAt: now },
          });
          await tx.insert(safetyAlerts).values({
            caseId: moderationCase.id,
            dedupeKey: `safety-alert:${moderationCase.id}`,
            createdAt: now,
          });
          const workflow = this.jurisdictionPolicy(target.countryCode ?? "ZZ");
          if (Number.isNaN(workflow.dueAt.getTime()) || workflow.dueAt <= now) {
            throw new Error("INVALID_LEGAL_WORKFLOW_CONFIGURATION");
          }
          await tx.insert(legalWorkflowTasks).values({
            caseId: moderationCase.id,
            jurisdictionCode: workflow.jurisdictionCode,
            workflowCode: workflow.workflowCode,
            dueAt: workflow.dueAt,
            dedupeKey: `legal-workflow:${moderationCase.id}:${workflow.workflowCode}`,
            createdAt: now,
          });
          await tx.insert(moderationOutboxEvents).values({
            caseId: moderationCase.id,
            eventType: "safety.alert.requested",
            dedupeKey: `moderation:safety-alert:${moderationCase.id}`,
            payload: { caseId: moderationCase.id, priority: "emergency" },
            availableAt: now,
            createdAt: now,
          });
        }
        return serializePublic(created, false);
      });
    } catch (error) {
      if (error instanceof ModerationError) throw error;
      if (dbErrorCode(error) !== "23505") throw error;
      const clientReplay = await this.findByClient(input.reporterUserId, input.report.clientId);
      if (clientReplay) return this.replay(clientReplay, requestHash);
      const semanticDuplicate = await this.findByDedupe(dedupeKey);
      if (semanticDuplicate) return serializePublic(semanticDuplicate, true);
      throw error;
    }
  }

  async listOwned(input: Parameters<ReportSubmissionRepository["listOwned"]>[0]) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new ModerationError("INVALID_CURSOR");
    }
    const cursor = this.decodeCursor(input.cursor);
    const rows = await this.database.select({
      id: reports.id,
      publicStatus: reports.publicStatus,
      reasonCode: reports.reasonCode,
      createdAt: reports.createdAt,
    }).from(reports).where(and(
      eq(reports.reporterUserId, input.reporterUserId),
      cursor ? or(
        lt(reports.createdAt, new Date(cursor.createdAt)),
        and(eq(reports.createdAt, new Date(cursor.createdAt)), lt(reports.id, cursor.id)),
      ) : undefined,
    )).orderBy(desc(reports.createdAt), desc(reports.id)).limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      reports: page.map((row) => ({
        id: row.id,
        status: row.publicStatus as PublicReport["status"],
        reason: row.reasonCode as SubmitReportInput["reason"],
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? this.encodeCursor({
        createdAt: page.at(-1)!.createdAt.toISOString(),
        id: page.at(-1)!.id,
      }) : null,
    };
  }

  private async authorizeReferences(
    tx: ModerationDatabase,
    reporterUserId: string,
    targetUserId: string,
    report: SubmitReportInput,
  ) {
    if (report.messageId && report.conversationId) {
      const [authorized] = await tx.select({ id: messages.id }).from(messages)
        .innerJoin(conversationMembers, and(
          eq(conversationMembers.conversationId, messages.conversationId),
          eq(conversationMembers.userId, reporterUserId),
        )).where(and(
          eq(messages.id, report.messageId),
          eq(messages.conversationId, report.conversationId),
          eq(messages.senderUserId, targetUserId),
        )).limit(1);
      if (!authorized) throw new ModerationError("REPORT_NOT_AVAILABLE");
    }
    for (const reference of report.evidenceReferences) {
      if (reference.type === "profile" && reference.id !== report.targetProfileId) {
        throw new ModerationError("REPORT_NOT_AVAILABLE");
      }
      if (reference.type === "photo") {
        const [photo] = await tx.select({ id: profilePhotos.id }).from(profilePhotos)
          .where(and(eq(profilePhotos.id, reference.id), eq(profilePhotos.userId, targetUserId))).limit(1);
        if (!photo) throw new ModerationError("REPORT_NOT_AVAILABLE");
      }
    }
  }

  private evidenceLocators(report: SubmitReportInput, targetProfileId: string) {
    const values: Array<{ kind: typeof moderationEvidence.$inferInsert["kind"]; locator: ControlledEvidenceLocator }> = [{
      kind: "target_snapshot",
      locator: { schemaVersion: 1, referenceType: "profile", referenceId: targetProfileId },
    }];
    if (report.messageId && report.conversationId) values.push({
      kind: "message_reference",
      locator: {
        schemaVersion: 1,
        referenceType: "message",
        referenceId: report.messageId,
        conversationId: report.conversationId,
      },
    });
    for (const reference of report.evidenceReferences) values.push({
      kind: reference.type === "profile" ? "profile_reference" : "photo_reference",
      locator: {
        schemaVersion: 1,
        referenceType: reference.type,
        referenceId: reference.id,
      },
    });
    return values;
  }

  private requestHash(report: SubmitReportInput) {
    return createHmac("sha256", this.idempotencySecret).update(canonical({
      targetProfileId: report.targetProfileId,
      reason: report.reason,
      locale: report.locale,
      explanation: report.explanation,
      messageId: report.messageId ?? null,
      conversationId: report.conversationId ?? null,
      evidenceReferences: report.evidenceReferences,
    })).digest("hex");
  }

  private dedupeKey(reporterUserId: string, report: SubmitReportInput) {
    return createHmac("sha256", this.idempotencySecret).update(canonical({
      reporterUserId,
      targetProfileId: report.targetProfileId,
      reason: report.reason,
      messageId: report.messageId ?? null,
      conversationId: report.conversationId ?? null,
    })).digest("hex");
  }

  private findByClient(reporterUserId: string, clientId: string, database = this.database) {
    return database.select().from(reports).where(and(
      eq(reports.reporterUserId, reporterUserId),
      eq(reports.clientId, clientId),
    )).limit(1).then((rows) => rows[0]);
  }

  private findByDedupe(dedupeKey: string, database = this.database) {
    return database.select().from(reports).where(and(
      eq(reports.dedupeKey, dedupeKey),
      or(eq(reports.publicStatus, "submitted"), eq(reports.publicStatus, "in_review")),
    )).limit(1).then((rows) => rows[0]);
  }

  private replay(row: typeof reports.$inferSelect, requestHash: string) {
    if (row.requestHash !== requestHash) throw new ModerationError("REPORT_IDEMPOTENCY_CONFLICT");
    return serializePublic(row, true);
  }

  private encodeCursor(cursor: Cursor) {
    const body = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.idempotencySecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private decodeCursor(value: string | undefined): Cursor | null {
    if (!value) return null;
    if (value.length > 1200) throw new ModerationError("INVALID_CURSOR");
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra) throw new ModerationError("INVALID_CURSOR");
    const expected = createHmac("sha256", this.idempotencySecret).update(body).digest("base64url");
    const suppliedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      throw new ModerationError("INVALID_CURSOR");
    }
    try {
      const cursor = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
      if (Object.keys(cursor).length !== 2 || Number.isNaN(Date.parse(cursor.createdAt))
        || !/^[0-9a-f-]{36}$/iu.test(cursor.id)) throw new Error();
      return cursor;
    } catch {
      throw new ModerationError("INVALID_CURSOR");
    }
  }
}
