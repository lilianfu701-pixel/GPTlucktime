// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleReportRepository } from "@/modules/moderation/report-repository";
import { ReportService, RuleBasedReportRiskAssessor } from "@/modules/moderation/report-service";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

runWithPostgres("report PostgreSQL concurrency with independent pools", () => {
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
});
