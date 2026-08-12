// @vitest-environment node

import { readdir, readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleCaseService } from "@/modules/moderation/case-service";
import { DrizzleMediaLegalHoldPolicy } from "@/modules/moderation/media-hold-policy";
import {
  preserveLegacyMediaTasks,
  unavailableMediaEvidencePreserver,
} from "@/modules/moderation/media-evidence-preserver";
import { DrizzleReportRepository } from "@/modules/moderation/report-repository";
import { ReportService, RuleBasedReportRiskAssessor } from "@/modules/moderation/report-service";
import { MediaReviewStore } from "@/modules/profiles/media-review-store";
import { cleanupRejectedMedia } from "@/workers/media-review-worker";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const ids = {
  targetUser: "00000000-0000-4000-8000-000000003601",
  targetProfile: "00000000-0000-4000-8000-000000003602",
  reporterUser: "00000000-0000-4000-8000-000000003603",
  reporterProfile: "00000000-0000-4000-8000-000000003604",
  legalUser: "00000000-0000-4000-8000-000000003605",
  legalProfile: "00000000-0000-4000-8000-000000003606",
  photo: "00000000-0000-4000-8000-000000003607",
  report: "00000000-0000-4000-8000-000000003608",
  moderationCase: "00000000-0000-4000-8000-000000003609",
  hold: "00000000-0000-4000-8000-000000003610",
  legalTask: "00000000-0000-4000-8000-000000003611",
  releasedPhoto: "00000000-0000-4000-8000-000000003614",
  releasedReport: "00000000-0000-4000-8000-000000003615",
  releasedCase: "00000000-0000-4000-8000-000000003616",
  releasedHold: "00000000-0000-4000-8000-000000003617",
};

const applyMigration = async (client: PGlite, name: string) => {
  const source = await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8");
  const statements = source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
  for (const [index, statement] of statements.entries()) {
    try {
      await client.exec(statement);
    } catch (error) {
      throw new Error(`MIGRATION_FAILED:${name}:${index}:${statement.slice(0, 80)}`, { cause: error });
    }
  }
};

describe("0036 legacy moderation media upgrade", () => {
  const clients: PGlite[] = [];
  afterEach(async () => Promise.all(clients.splice(0).map((client) => client.close())));

  it("upgrades legacy holds and quarantines unversioned photos without losing reports or evidence", async () => {
    const client = new PGlite();
    clients.push(client);
    const migrationsThrough0034 = (await readdir(new URL("../../../drizzle", import.meta.url)))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0035_")
      .sort();
    for (const name of migrationsThrough0034) await applyMigration(client, name);

    await client.query(`
      INSERT INTO users (id,name,email,email_verified) VALUES
        ($1,'Legacy target','legacy-target@example.test',true),
        ($2,'Legacy reporter','legacy-reporter@example.test',true),
        ($3,'Legacy legal','legacy-legal@example.test',true)
    `, [ids.targetUser, ids.reporterUser, ids.legalUser]);
    await client.query(`
      INSERT INTO profiles
        (id,user_id,display_name,birth_date,gender_code,relationship_goal_code,country_code,city,status,discoverable,time_zone)
      VALUES
        ($1,$2,'Legacy target','1990-01-01','person','long_term','US','Seattle','active',true,'UTC'),
        ($3,$4,'Legacy reporter','1990-01-01','person','long_term','US','Seattle','active',true,'UTC'),
        ($5,$6,'Legacy legal','1990-01-01','person','long_term','US','Seattle','active',true,'UTC')
    `, [ids.targetProfile, ids.targetUser, ids.reporterProfile, ids.reporterUser, ids.legalProfile, ids.legalUser]);
    await client.query(`
      INSERT INTO profile_photos
        (id,user_id,profile_id,object_key,position,moderation_status,cleanup_due_at,user_removed_at)
      VALUES
        ($1,$2,$3,'legacy-media/original.jpg',0,'approved',$5,$5),
        ($4,$2,$3,'legacy-media/already-released.jpg',1,'approved',$5,$5)
    `, [ids.photo, ids.targetUser, ids.targetProfile, ids.releasedPhoto, new Date(NOW.getTime() - 60_000)]);
    await client.query(`
      INSERT INTO reports
        (id,reporter_user_id,target_user_id,target_profile_id,target_type,reason_code,locale,explanation,
         client_id,request_hash,dedupe_key,target_snapshot,public_status,created_at,updated_at)
      VALUES
        ($1,$2,$3,$4,'profile','MINOR_SAFETY','en-US','legacy safety report',
         '00000000-0000-4000-8000-000000003612',$5,$6,$7::jsonb,'resolved',$8,$8)
    `, [
      ids.report, ids.reporterUser, ids.targetUser, ids.targetProfile, "a".repeat(64), "b".repeat(64),
      JSON.stringify({
        schemaVersion: 1,
        targetType: "profile",
        targetUserId: ids.targetUser,
        targetProfileId: ids.targetProfile,
        capturedAt: NOW.toISOString(),
        displayName: "Legacy target",
        messageId: null,
        conversationId: null,
      }), NOW,
    ]);
    await client.query(`
      INSERT INTO moderation_cases (id,report_id,status,priority,created_at,updated_at)
      VALUES ($1,$2,'triaged','emergency',$3,$3)
    `, [ids.moderationCase, ids.report, NOW]);
    await client.query(`
      INSERT INTO moderation_media_holds
        (id,report_id,case_id,subject_user_id,photo_id,object_key,object_version,snapshot_sha256,preserve_until,created_at)
      VALUES ($1,$2,$3,$4,$5,'legacy-media/original.jpg','legacy-unverified-version',$6,$7,$8)
    `, [ids.hold, ids.report, ids.moderationCase, ids.targetUser, ids.photo, "c".repeat(64),
      new Date(NOW.getTime() + 86_400_000), NOW]);
    await client.query(`
      INSERT INTO legal_workflow_tasks (id,case_id,jurisdiction_code,workflow_code,status,due_at,dedupe_key,created_at)
      VALUES ($1,$2,'US','legacy-review','pending',$3,'legacy-review:0036',$4)
    `, [ids.legalTask, ids.moderationCase, new Date(NOW.getTime() + 60_000), NOW]);
    await client.query(`
      INSERT INTO reports
        (id,reporter_user_id,target_user_id,target_profile_id,target_type,reason_code,locale,explanation,
         client_id,request_hash,dedupe_key,target_snapshot,public_status,created_at,updated_at)
      SELECT $1,reporter_user_id,target_user_id,target_profile_id,target_type,reason_code,locale,
        'already released legacy hold', '00000000-0000-4000-8000-000000003618',$2,$3,target_snapshot,
        'resolved',created_at,updated_at FROM reports WHERE id=$4
    `, [ids.releasedReport, "d".repeat(64), "e".repeat(64), ids.report]);
    await client.query(`
      INSERT INTO moderation_cases (id,report_id,status,priority,created_at,updated_at)
      VALUES ($1,$2,'triaged','emergency',$3,$3)
    `, [ids.releasedCase, ids.releasedReport, NOW]);
    await client.query(`
      INSERT INTO moderation_media_holds
        (id,report_id,case_id,subject_user_id,photo_id,object_key,object_version,snapshot_sha256,
         preserve_until,active,released_at,created_at)
      VALUES ($1,$2,$3,$4,$5,'legacy-media/already-released.jpg','legacy-unverified-version',$6,$7,false,$8,$8)
    `, [ids.releasedHold, ids.releasedReport, ids.releasedCase, ids.targetUser, ids.releasedPhoto,
      "f".repeat(64), new Date(NOW.getTime() + 86_400_000), new Date(NOW.getTime() - 30_000)]);

    await applyMigration(client, "0035_early_hellion.sql");
    await applyMigration(client, "0036_legacy_media_preservation.sql");
    await applyMigration(client, "0037_lock_legacy_preservation.sql");

    expect((await client.query<{ preservation_status: string }>(
      "SELECT preservation_status FROM profile_photos WHERE id=$1",
      [ids.photo],
    )).rows).toEqual([{ preservation_status: "legacy_unversioned" }]);
    expect((await client.query<{ legacy: boolean; evidence_copy_id: string | null }>(
      "SELECT legacy,evidence_copy_id FROM moderation_media_holds WHERE id=$1",
      [ids.hold],
    )).rows).toEqual([{ legacy: true, evidence_copy_id: null }]);
    expect((await client.query<{ legacy: boolean; active: boolean; released_by_user_id: string | null }>(
      "SELECT legacy,active,released_by_user_id FROM moderation_media_holds WHERE id=$1",
      [ids.releasedHold],
    )).rows).toEqual([{ legacy: true, active: false, released_by_user_id: null }]);

    await expect(client.query(
      "UPDATE moderation_media_holds SET object_key='forged' WHERE id=$1",
      [ids.hold],
    )).rejects.toThrow();

    const database = drizzle(client, { schema });
    const caseService = new DrizzleCaseService(database, {
      clock: () => NOW,
      resolveEvidenceReaderRole: async (userId) => userId === ids.legalUser ? "legal_reviewer" : null,
    });
    await expect(caseService.releaseMediaHolds(ids.moderationCase, {
      userId: ids.legalUser,
      role: "legal_reviewer",
    }, "legacy hold reviewed").catch((error) => {
      throw new Error("LEGACY_RELEASE_STAGE", { cause: error });
    })).resolves.toEqual({ releasedCount: 1 });
    expect((await client.query<{ active: boolean; released_by_user_id: string | null }>(
      "SELECT active,released_by_user_id FROM moderation_media_holds WHERE id=$1",
      [ids.hold],
    )).rows).toEqual([{ active: false, released_by_user_id: ids.legalUser }]);
    expect((await client.query<{ event_type: string }>(
      "SELECT event_type FROM moderation_audit_events WHERE case_id=$1 AND event_type='media_hold_released'",
      [ids.moderationCase],
    )).rows).toEqual([{ event_type: "media_hold_released" }]);

    const store = new MediaReviewStore(database, { clock: () => NOW });
    const deleted: string[] = [];
    await expect(cleanupRejectedMedia({
      store,
      storage: { deleteObject: async (key: string) => { deleted.push(key); } } as never,
      holdPolicy: new DrizzleMediaLegalHoldPolicy(database as never),
      clock: () => NOW,
    })).resolves.toBe(0);
    expect(deleted).toEqual([]);

    const reportService = new ReportService(new DrizzleReportRepository(database, {
      idempotencySecret: "legacy-upgrade-report-secret",
      mediaHoldPolicy: new DrizzleMediaLegalHoldPolicy(database as never),
      mediaEvidencePreserver: unavailableMediaEvidencePreserver,
      clock: () => NOW,
      jurisdictionPolicy: (countryCode) => ({
        jurisdictionCode: countryCode,
        workflowCode: "legacy-media-review-v1",
        dueAt: new Date(NOW.getTime() + 60_000),
      }),
    }), new RuleBasedReportRiskAssessor());
    const submitted = await reportService.submit(ids.reporterUser, {
      clientId: "00000000-0000-4000-8000-000000003613",
      targetProfileId: ids.targetProfile,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "legacy media must preserve report availability",
      evidenceReferences: [{ type: "photo", id: ids.photo }],
    }).catch((error) => {
      throw new Error("LEGACY_REPORT_STAGE", { cause: error });
    });
    expect(submitted).toMatchObject({ status: "submitted" });
    expect((await client.query<{ status: string; source_object_key: string }>(
      "SELECT status,source_object_key FROM media_preservation_tasks WHERE photo_id=$1",
      [ids.photo],
    )).rows).toEqual([{ status: "pending", source_object_key: "legacy-media/original.jpg" }]);
    expect((await client.query<{ event_type: string }>(
      "SELECT event_type FROM moderation_outbox_events WHERE event_type='media.legacy_preservation.requested'",
    )).rows).toHaveLength(1);
    const [submittedCase] = (await client.query<{ id: string }>(
      "SELECT id FROM moderation_cases WHERE report_id=$1",
      [submitted.id],
    )).rows;
    await expect(client.query(`
      INSERT INTO moderation_media_holds
        (report_id,case_id,subject_user_id,photo_id,evidence_copy_id,legacy,object_key,object_version,
         snapshot_sha256,preserve_until,created_at)
      VALUES ($1,$2,$3,$4,NULL,true,'forged/legacy.jpg','forged-version',$5,$6,$7)
    `, [submitted.id, submittedCase!.id, ids.targetUser, ids.photo, "1".repeat(64),
      new Date(NOW.getTime() + 86_400_000), NOW])).rejects.toThrow();

    const copied: Array<{ source: string; destination: string; sourceVersionId?: string }> = [];
    await expect(preserveLegacyMediaTasks({
      database: database as never,
      storage: {
        headObject: async (objectKey: string) => objectKey === "legacy-media/original.jpg"
          ? { sizeBytes: 100, mimeType: "image/jpeg", etag: "current-source-etag", versionId: "current-source-version" }
          : { sizeBytes: 100, mimeType: "image/jpeg", etag: "restricted-copy-etag", versionId: "restricted-copy-version" },
        copyObject: async (source, destination, options) => {
          copied.push({ source, destination, sourceVersionId: options.sourceVersionId });
        },
      },
      clock: () => NOW,
    })).resolves.toBe(1);
    expect(copied).toEqual([{
      source: "legacy-media/original.jpg",
      destination: `restricted-evidence/${submitted.id}/${ids.photo}`,
      sourceVersionId: "current-source-version",
    }]);
    expect((await client.query<{ capture_mode: string; source_object_version: string; object_version: string }>(
      "SELECT capture_mode,source_object_version,object_version FROM moderation_media_copies WHERE report_id=$1",
      [submitted.id],
    )).rows).toEqual([{
      capture_mode: "current_object_etag",
      source_object_version: "current-source-version",
      object_version: "restricted-copy-version",
    }]);
    expect((await client.query<{ legacy: boolean; object_version: string }>(
      "SELECT legacy,object_version FROM moderation_media_holds WHERE report_id=$1",
      [submitted.id],
    )).rows).toEqual([{ legacy: false, object_version: "restricted-copy-version" }]);
    expect((await client.query<{ preservation_status: string }>(
      "SELECT preservation_status FROM profile_photos WHERE id=$1",
      [ids.photo],
    )).rows).toEqual([{ preservation_status: "legacy_preserved" }]);
  });
});
