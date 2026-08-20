// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as appSchema from "@/db/schema";
import { DrizzlePrivacyRepository } from "@/modules/profiles/privacy-repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

runWithPostgres("privacy PostgreSQL concurrency with independent pools (requires TEST_DATABASE_URL)", () => {
  const schemaName = `privacy_test_${randomUUID().replaceAll("-", "")}`;
  let administrationPool: Pool;
  let leftPool: Pool;
  let rightPool: Pool;

  const migrate = async (client: PoolClient) => {
    await client.query("begin");
    try {
      await client.query(`set local search_path to "${schemaName}"`);
      const names = (await readdir(new URL("../../../drizzle", import.meta.url)))
        .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
      for (const name of names) {
        const source = (await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8"))
          .replaceAll('"public".', `"${schemaName}".`);
        for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
          await client.query(statement);
        }
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
  };

  beforeAll(async () => {
    administrationPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await administrationPool.query(`create schema "${schemaName}"`);
    const client = await administrationPool.connect();
    try { await migrate(client); } finally { client.release(); }
    leftPool = new Pool({ connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName} -c application_name=privacy_left`, max: 2 });
    rightPool = new Pool({ connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName} -c application_name=privacy_right`, max: 2 });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([leftPool?.end(), rightPool?.end()]);
    if (administrationPool) {
      await administrationPool.query(`drop schema if exists "${schemaName}" cascade`);
      await administrationPool.end();
    }
  });

  const createUser = async (suffix: string) => (await leftPool.query(
    "insert into users (name,email,email_verified) values ($1,$2,true) returning id",
    [`privacy-${suffix}`, `${schemaName}-${suffix}@example.test`],
  )).rows[0] as { id: string };

  it("claims around an independently locked row with SKIP LOCKED and fences a recovered lease", async () => {
    const [first, second] = await Promise.all([createUser("first"), createUser("second")]);
    const firstJob = await leftPool.query(`insert into notification_outbox
      (user_id,dedupe_key,category,template_key,locale,channels,available_at,created_at)
      values ($1,$2,'transactional','privacy.exportReady','en',array['inApp'],current_timestamp,current_timestamp - interval '2 seconds')
      returning id`, [first.id, randomUUID()]);
    const secondJob = await leftPool.query(`insert into notification_outbox
      (user_id,dedupe_key,category,template_key,locale,channels,available_at,created_at)
      values ($1,$2,'transactional','privacy.exportReady','en',array['inApp'],current_timestamp,current_timestamp - interval '1 second')
      returning id`, [second.id, randomUUID()]);
    const firstId = firstJob.rows[0]!.id as string;
    const secondId = secondJob.rows[0]!.id as string;
    const left = await leftPool.connect();
    const leaseA = randomUUID();
    const leaseB = randomUUID();
    try {
      await left.query("begin");
      await left.query("select id from notification_outbox where id=$1 for update", [firstId]);
      const claimed = await rightPool.query(`with candidate as (
        select id from notification_outbox where status='pending' and available_at <= current_timestamp
        order by created_at for update skip locked limit 1
      ) update notification_outbox n set status='processing',attempts=attempts+1,lease_id=$1,
        lease_expires_at=current_timestamp + interval '30 seconds' from candidate where n.id=candidate.id returning n.id`, [leaseA]);
      expect(claimed.rows).toEqual([{ id: secondId }]);
      await left.query("commit");
    } finally {
      left.release();
    }

    await leftPool.query(`update notification_outbox set lease_expires_at=current_timestamp - interval '1 second'
      where id=$1 and lease_id=$2`, [secondId, leaseA]);
    const recovered = await rightPool.query(`update notification_outbox set lease_id=$2,
      lease_expires_at=current_timestamp + interval '30 seconds' where id=$1 and status='processing'
      and lease_id=$3 and lease_expires_at <= current_timestamp returning id`, [secondId, leaseB, leaseA]);
    expect(recovered.rowCount).toBe(1);
    const staleCompletion = await leftPool.query(`update notification_outbox set status='sent',sent_at=current_timestamp,
      lease_id=null,lease_expires_at=null where id=$1 and status='processing' and lease_id=$2
      and lease_expires_at > current_timestamp returning id`, [secondId, leaseA]);
    expect(staleCompletion.rowCount).toBe(0);
  });

  it("deduplicates concurrent outbox production from independent pools", async () => {
    const user = await createUser("dedupe");
    const dedupeKey = `privacy-ready:${randomUUID()}`;
    const enqueue = (pool: Pool) => pool.query(`insert into notification_outbox
      (user_id,dedupe_key,category,template_key,locale,channels)
      values ($1,$2,'transactional','privacy.exportReady','en',array['inApp'])
      on conflict (user_id,dedupe_key) do nothing returning id`, [user.id, dedupeKey]);
    const [left, right] = await Promise.all([enqueue(leftPool), enqueue(rightPool)]);
    expect((left.rowCount ?? 0) + (right.rowCount ?? 0)).toBe(1);
    expect((await leftPool.query("select count(*)::int as count from notification_outbox where user_id=$1 and dedupe_key=$2",
      [user.id, dedupeKey])).rows[0]).toEqual({ count: 1 });
  });

  it("leaves no session created concurrently with a committed deletion request", async () => {
    const user = await createUser("session-fence");
    const left = await leftPool.connect();
    try {
      await left.query("begin");
      await left.query(`insert into account_deletion_requests
        (user_id,idempotency_key,execute_at,available_at,created_at,cancellation_token_hash,cancellation_token_expires_at)
        values ($1,$2,current_timestamp + interval '30 days',current_timestamp + interval '30 days',current_timestamp,
          repeat('a',64),current_timestamp + interval '30 days')`, [user.id, `delete-${randomUUID()}`]);
      const concurrentInsert = rightPool.query(`insert into sessions (token,expires_at,user_id)
        values ($1,current_timestamp + interval '1 day',$2)`, [`session-${randomUUID()}`, user.id]);
      let lockObserved = false;
      for (let attempt = 0; attempt < 100 && !lockObserved; attempt += 1) {
        const activity = await administrationPool.query(`select wait_event_type from pg_stat_activity
          where application_name='privacy_right' and wait_event_type='Lock'`);
        lockObserved = activity.rowCount === 1;
        if (!lockObserved) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lockObserved).toBe(true);
      await left.query("commit");
      await expect(concurrentInsert).rejects.toThrow(/ACCOUNT_DELETION_IN_PROGRESS/u);
      expect((await leftPool.query("select count(*)::int as count from sessions where user_id=$1", [user.id])).rows[0])
        .toEqual({ count: 0 });
    } finally {
      await left.query("rollback").catch(() => undefined);
      left.release();
    }
  });

  it("allows only one independent pool to reserve a download token", async () => {
    const user = await createUser("download-claim"); const jobId = randomUUID(); const token = "d".repeat(43);
    const tokenHash = createHash("sha256").update(token).digest("hex"); const now = new Date();
    await leftPool.query(`insert into privacy_export_jobs
      (id,user_id,idempotency_key,status,object_key,object_version,integrity_sha256,encryption_key_id,
       expires_at,completed_at,download_token_hash,download_token_expires_at)
      values ($1,$2,$3,'ready',$4,'version-1',repeat('a',64),'privacy-export-v1',
        current_timestamp+interval '1 day',current_timestamp,$5,current_timestamp+interval '15 minutes')`,
    [jobId, user.id, `export-${randomUUID()}`, `privacy/${user.id}/export.enc`, tokenHash]);
    const leftRepository = new DrizzlePrivacyRepository(drizzle(leftPool, { schema: appSchema }) as never);
    const rightRepository = new DrizzlePrivacyRepository(drizzle(rightPool, { schema: appSchema }) as never);
    const input = { userId: user.id, jobId, token, now };
    const claims = await Promise.all([leftRepository.claimDownload(input), rightRepository.claimDownload(input)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
