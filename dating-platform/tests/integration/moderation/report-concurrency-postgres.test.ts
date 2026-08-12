// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleReportRepository } from "@/modules/moderation/report-repository";
import { ReportService, RuleBasedReportRiskAssessor } from "@/modules/moderation/report-service";
import { DrizzleMediaLegalHoldPolicy } from "@/modules/moderation/media-hold-policy";
import { unavailableMediaEvidencePreserver } from "@/modules/moderation/media-evidence-preserver";
import type { MediaEvidencePreserver } from "@/modules/moderation/media-evidence-preserver";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

runWithPostgres("report PostgreSQL concurrency with independent pools (requires TEST_DATABASE_URL)", () => {
  const schemaName = `moderation_test_${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-08-11T12:00:00.000Z");
  let administrationPool: Pool;
  let leftPool: Pool;
  let rightPool: Pool;
  let leftDatabase: ReturnType<typeof drizzle<typeof schema>>;
  let rightDatabase: ReturnType<typeof drizzle<typeof schema>>;
  let leftService: ReportService;
  let rightService: ReportService;

  const migrateIsolatedSchema = async (client: PoolClient) => {
    await client.query("begin");
    try {
      await client.query(`set local search_path to "${schemaName}"`);
      const names = (await readdir(new URL("../../../drizzle", import.meta.url)))
        .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
      for (const name of names) {
        const source = await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8");
        const isolated = source.replaceAll('"public".', `"${schemaName}".`);
        for (const statement of isolated.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
          await client.query(statement);
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  };

  const repository = (database: unknown) => new DrizzleReportRepository(database, {
    idempotencySecret: "postgres-moderation-concurrency-secret",
    mediaHoldPolicy: new DrizzleMediaLegalHoldPolicy(database as never),
    mediaEvidencePreserver: unavailableMediaEvidencePreserver,
    clock: () => now,
    jurisdictionPolicy: (countryCode) => ({
      jurisdictionCode: countryCode,
      workflowCode: "minor-safety-review-v1",
      dueAt: new Date(now.getTime() + 60 * 60_000),
    }),
  });

  beforeAll(async () => {
    administrationPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await administrationPool.query(`create schema "${schemaName}"`);
    const migrationClient = await administrationPool.connect();
    try { await migrateIsolatedSchema(migrationClient); } finally { migrationClient.release(); }
    const options = { connectionString: TEST_DATABASE_URL, options: `-c search_path=${schemaName}`, max: 2 };
    leftPool = new Pool(options);
    rightPool = new Pool(options);
    leftDatabase = drizzle(leftPool, { schema });
    rightDatabase = drizzle(rightPool, { schema });
    leftService = new ReportService(repository(leftDatabase), new RuleBasedReportRiskAssessor());
    rightService = new ReportService(repository(rightDatabase), new RuleBasedReportRiskAssessor());
  }, 30_000);

  afterAll(async () => {
    await Promise.all([leftPool?.end(), rightPool?.end()]);
    if (administrationPool) {
      await administrationPool.query(`drop schema if exists "${schemaName}" cascade`);
      await administrationPool.end();
    }
  });

  it("persists one report and one emergency workflow for concurrent semantic duplicates", async () => {
    const [reporter] = await leftDatabase.insert(schema.users).values({
      name: "PG Reporter", email: `${schemaName}-reporter@example.test`,
    }).returning();
    const [target] = await leftDatabase.insert(schema.users).values({
      name: "PG Target", email: `${schemaName}-target@example.test`,
    }).returning();
    const [targetProfile] = await leftDatabase.insert(schema.profiles).values({
      userId: target.id,
      displayName: "PG Target",
      birthDate: "1990-01-01",
      genderCode: "person",
      countryCode: "US",
      timeZone: "UTC",
      status: "active",
      discoverable: true,
    }).returning();
    const base = {
      targetProfileId: targetProfile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "concurrent safety report",
      evidenceReferences: [],
    };
    const results = await Promise.all([
      leftService.submit(reporter.id, {
        ...base, clientId: "00000000-0000-4000-8000-000000000811",
      }),
      rightService.submit(reporter.id, {
        ...base, clientId: "00000000-0000-4000-8000-000000000812",
      }),
    ]);
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(results.map(({ duplicate }) => duplicate).sort()).toEqual([false, true]);
    expect(await leftDatabase.select().from(schema.reports)).toHaveLength(1);
    expect(await leftDatabase.select().from(schema.userRestrictions)).toHaveLength(1);
    expect(await leftDatabase.select().from(schema.safetyAlerts)).toHaveLength(1);
    expect(await leftDatabase.select().from(schema.legalWorkflowTasks)).toHaveLength(1);
  });

  it("serializes an in-flight independent message insert behind restriction activation", async () => {
    const [reporter] = await leftDatabase.insert(schema.users).values({
      name: "PG Activation Reporter", email: `${schemaName}-activation-reporter@example.test`,
    }).returning();
    const [target] = await leftDatabase.insert(schema.users).values({
      name: "PG Activation Target", email: `${schemaName}-activation-target@example.test`,
    }).returning();
    const [profile] = await leftDatabase.insert(schema.profiles).values({
      userId: target.id, displayName: "Target", birthDate: "1990-01-01", genderCode: "person",
      countryCode: "US", timeZone: "UTC", status: "active", discoverable: true,
    }).returning();
    const [lowUserId, highUserId] = [reporter.id, target.id].sort();
    const [conversation] = await leftDatabase.insert(schema.conversations).values({ lowUserId, highUserId }).returning();
    await leftDatabase.insert(schema.conversationMembers).values([
      { conversationId: conversation.id, userId: lowUserId, lowUserId, highUserId },
      { conversationId: conversation.id, userId: highUserId, lowUserId, highUserId },
    ]);
    const report = await leftService.submit(reporter.id, {
      clientId: "00000000-0000-4000-8000-000000000899",
      targetProfileId: profile.id,
      reason: "HARASSMENT",
      locale: "en-US",
      explanation: "create a source case for a controlled activation barrier",
      evidenceReferences: [],
    });
    const [moderationCase] = await leftDatabase.select({ id: schema.moderationCases.id })
      .from(schema.moderationCases).where(eq(schema.moderationCases.reportId, report.id));
    const activation = await leftPool.connect();
    await activation.query("begin");
    await activation.query("select id from users where id in ($1, $2) order by id for update", [lowUserId, highUserId]);
    await activation.query(`insert into user_restrictions
      (subject_user_id, source_case_id, scope, reason_code, starts_at, expires_at)
      values ($1, $2, 'all_interactions', 'CONTROLLED_ACTIVATION', $3, $4)`, [
      target.id,
      moderationCase!.id,
      now,
      new Date(now.getTime() + 60_000),
    ]);
    const lateInsert = rightDatabase.insert(schema.messages).values({
      conversationId: conversation.id,
      lowUserId,
      highUserId,
      sequence: 1,
      senderUserId: target.id,
      clientId: "00000000-0000-4000-8000-000000000898",
      body: "must not appear after activation",
      createdAt: now,
    }).then(
      () => ({ status: "fulfilled" as const, error: null }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const beforeCommit = await Promise.race([
      lateInsert.then(({ status }) => status),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    await activation.query("commit");
    activation.release();
    expect(beforeCommit).toBe("pending");
    const result = await lateInsert;
    expect(result.status).toBe("rejected");
    expect(result.error).toBeTruthy();
    expect(await leftDatabase.select().from(schema.messages)).toEqual([]);
  });

  it("coordinates hold creation and cleanup leases across independent pools", async () => {
    const [reporter] = await leftDatabase.insert(schema.users).values({
      name: "PG Hold Reporter", email: `${schemaName}-hold-reporter@example.test`,
    }).returning();
    const [secondReporter] = await leftDatabase.insert(schema.users).values({
      name: "PG Hold Reporter Two", email: `${schemaName}-hold-reporter-two@example.test`,
    }).returning();
    const [target] = await leftDatabase.insert(schema.users).values({
      name: "PG Hold Target", email: `${schemaName}-hold-target@example.test`,
    }).returning();
    const [profile] = await leftDatabase.insert(schema.profiles).values({
      userId: target.id, displayName: "Hold Target", birthDate: "1990-01-01", genderCode: "person",
      countryCode: "US", timeZone: "UTC", status: "active", discoverable: true,
    }).returning();
    const [firstPhoto, secondPhoto] = await leftDatabase.insert(schema.profilePhotos).values([
      {
        userId: target.id, profileId: profile.id, objectKey: `${schemaName}/claim-first.jpg`,
        objectVersion: "claim-first-version", objectEtag: "claim-first-etag", position: 0,
        moderationStatus: "approved", cleanupDueAt: now, userRemovedAt: now,
      },
      {
        userId: target.id, profileId: profile.id, objectKey: `${schemaName}/hold-first.jpg`,
        objectVersion: "hold-first-version", objectEtag: "hold-first-etag", position: 1,
        moderationStatus: "approved", cleanupDueAt: now, userRemovedAt: now,
      },
    ]).returning();
    const leftCoordinator = new DrizzleMediaLegalHoldPolicy(leftDatabase as never);
    const rightCoordinator = new DrizzleMediaLegalHoldPolicy(rightDatabase as never);
    const preserver: MediaEvidencePreserver = {
      preserve: async (source, destinationObjectKey) => ({
        objectKey: destinationObjectKey,
        objectVersion: `copy-${source.objectVersion}`,
        objectEtag: `copy-${source.objectEtag}`,
      }),
    };
    const photoService = (database: unknown, coordinator: DrizzleMediaLegalHoldPolicy) => new ReportService(
      new DrizzleReportRepository(database, {
        idempotencySecret: "postgres-hold-concurrency-secret",
        clock: () => now,
        mediaHoldPolicy: coordinator,
        mediaEvidencePreserver: preserver,
        jurisdictionPolicy: (countryCode) => ({
          jurisdictionCode: countryCode,
          workflowCode: "minor-safety-review-v1",
          dueAt: new Date(now.getTime() + 60 * 60_000),
        }),
      }),
      new RuleBasedReportRiskAssessor(),
    );

    const claim = await leftCoordinator.claimDeletion(firstPhoto.id, firstPhoto.objectKey, now);
    expect(claim).toBeTruthy();
    await photoService(rightDatabase, rightCoordinator).submit(reporter.id, {
      clientId: "00000000-0000-4000-8000-000000000991",
      targetProfileId: profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "independent pool invalidates deletion claim",
      evidenceReferences: [{ type: "photo", id: firstPhoto.id }],
    });
    await expect(leftCoordinator.validateDeletionClaim(claim!, now)).resolves.toBe(false);

    let holdLockedResolve!: () => void;
    let resumeHoldResolve!: () => void;
    const holdLocked = new Promise<void>((resolve) => { holdLockedResolve = resolve; });
    const resumeHold = new Promise<void>((resolve) => { resumeHoldResolve = resolve; });
    const paused: DrizzleMediaLegalHoldPolicy = Object.create(leftCoordinator) as DrizzleMediaLegalHoldPolicy;
    paused.prepareHoldInTransaction = async (...args) => {
      const source = await leftCoordinator.prepareHoldInTransaction(...args);
      holdLockedResolve();
      await resumeHold;
      return source;
    };
    const reporting = photoService(leftDatabase, paused).submit(secondReporter.id, {
      clientId: "00000000-0000-4000-8000-000000000992",
      targetProfileId: profile.id,
      reason: "MINOR_SAFETY",
      locale: "en-US",
      explanation: "independent pool cleanup waits for hold",
      evidenceReferences: [{ type: "photo", id: secondPhoto.id }],
    });
    await holdLocked;
    const cleanupClaim = rightCoordinator.claimDeletion(secondPhoto.id, secondPhoto.objectKey, now);
    expect(await Promise.race([
      cleanupClaim.then(() => "finished" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ])).toBe("pending");
    resumeHoldResolve();
    await reporting;
    await expect(cleanupClaim).resolves.toBeNull();
  });
});
