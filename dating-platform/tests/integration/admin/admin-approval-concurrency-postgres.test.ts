// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

runWithPostgres("admin approval PostgreSQL concurrency (requires TEST_DATABASE_URL)", () => {
  const schemaName = `admin_test_${randomUUID().replaceAll("-", "")}`;
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
    const options = { connectionString: TEST_DATABASE_URL, options: `-c search_path=${schemaName}`, max: 2 };
    leftPool = new Pool(options);
    rightPool = new Pool(options);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([leftPool?.end(), rightPool?.end()]);
    if (administrationPool) {
      await administrationPool.query(`drop schema if exists "${schemaName}" cascade`);
      await administrationPool.end();
    }
  });

  it("allows one independent decision and rejects a support/no-permission session at the database boundary", async () => {
    const users = (await leftPool.query(`insert into users (name,email,email_verified) values
      ('requester',$1,true),('approver',$2,true),('support',$3,true) returning id`, [
      `${schemaName}-requester@example.test`, `${schemaName}-approver@example.test`, `${schemaName}-support@example.test`,
    ])).rows as Array<{ id: string }>;
    const assignments = (await leftPool.query(`insert into admin_role_assignments (user_id,role) values
      ($1,'finance'),($2,'finance'),($3,'support') returning id,user_id`, users.map(({ id }) => id))).rows as
      Array<{ id: string; user_id: string }>;
    const sessions = (await leftPool.query(`insert into admin_sessions
      (user_id,role_assignment_id,token_hash,mfa_verified_at,expires_at) values
      ($1,$2,$3,current_timestamp,current_timestamp + interval '10 minutes'),
      ($4,$5,$6,current_timestamp,current_timestamp + interval '10 minutes'),
      ($7,$8,$9,current_timestamp,current_timestamp + interval '10 minutes') returning id,user_id`, [
      users[0]!.id, assignments[0]!.id, "1".repeat(64), users[1]!.id, assignments[1]!.id, "2".repeat(64),
      users[2]!.id, assignments[2]!.id, "3".repeat(64),
    ])).rows as Array<{ id: string; user_id: string }>;
    const createRequest = async () => (await leftPool.query(`insert into admin_approval_requests
      (requester_user_id,requester_admin_session_id,request_id,ip_hash,action,request_permission,
       approval_permission,target_type,target_id,payload_version,payload,payload_hash,reason,expires_at)
      values ($1,$2,$3,$4,'manual_refund','billing.refund.request','billing.refund.approve','payment',$5,1,
       '{"paymentId":"00000000-0000-4000-8000-000000000001","amount":100}'::jsonb,$6,'verified duplicate charge',
       current_timestamp + interval '10 minutes') returning id`, [users[0]!.id, sessions[0]!.id, randomUUID(),
      "a".repeat(64), randomUUID(), "b".repeat(64)])).rows[0] as { id: string };
    const request = await createRequest();
    const decide = (pool: Pool) => pool.query(`insert into admin_approval_decisions
      (request_id,approver_user_id,approver_admin_session_id,permission,decision,reason)
      values ($1,$2,$3,'billing.refund.approve','approved','independent ledger review')`,
    [request.id, users[1]!.id, sessions[1]!.id]);
    const concurrent = await Promise.allSettled([decide(leftPool), decide(rightPool)]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const second = await createRequest();
    await expect(leftPool.query(`insert into admin_approval_decisions
      (request_id,approver_user_id,approver_admin_session_id,permission,decision,reason)
      values ($1,$2,$3,'billing.refund.approve','approved','forged support approval')`,
    [second.id, users[2]!.id, sessions[2]!.id])).rejects.toThrow();
  });
});
