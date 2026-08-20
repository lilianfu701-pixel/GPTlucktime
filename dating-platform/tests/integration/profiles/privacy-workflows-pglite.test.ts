import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleDeletionWorkerStore, DrizzlePrivacyExportWorkerStore,
  DrizzlePrivacyWorkflowStore } from "@/modules/profiles/privacy-worker-store";

describe("privacy workflow migration", () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  }, 30_000);

  afterEach(async () => client.close());

  const user = async () => {
    const id = crypto.randomUUID();
    await client.query("insert into users (id, name, email) values ($1, 'Owner', $2)", [id, `${id}@example.test`]);
    await client.query("insert into profiles (user_id, discoverable, status) values ($1, true, 'active')", [id]);
    await client.query("insert into sessions (expires_at, token, user_id) values (now() + interval '1 day', $1, $2)",
      [`token-${id}`, id]);
    return id;
  };

  const activeSubscription = async (userId: string) => {
    const planId = crypto.randomUUID();
    const priceId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    await client.query(`insert into billing_plans
      (id, plan_ref, version, name_key, description_key, effective_at)
      values ($1, 'premium', 1, 'billing.premium.name', 'billing.premium.description', now() - interval '1 day')`,
    [planId]);
    await client.query(`insert into billing_prices
      (id, plan_id, version, country_code, currency, unit_amount, interval, interval_count, tax_mode,
       provider_price_id, effective_at)
      values ($1, $2, 1, 'US', 'USD', 1000, 'monthly', 1, 'exclusive', $3, now() - interval '1 day')`,
    [priceId, planId, `price-${priceId}`]);
    await client.query(`insert into billing_customers (user_id, provider_customer_id)
      values ($1, $2)`, [userId, `customer-${userId}`]);
    await client.query(`insert into billing_subscriptions
      (id, user_id, price_id, plan_ref, provider_customer_id, provider_subscription_id, status,
       provider_status, provider_object_version, provider_event_created_at, cancel_at_period_end)
      values ($1, $2, $3, 'premium', $4, $5, 'active', 'active', 1, now(), false)`,
    [subscriptionId, userId, priceId, `customer-${userId}`, `subscription-${subscriptionId}`]);
    return subscriptionId;
  };

  it("atomically revokes sessions, hides discovery, and records durable effects", async () => {
    const userId = await user();
    const deletionId = crypto.randomUUID();
    await client.query(`insert into account_deletion_requests
      (id, user_id, idempotency_key, execute_at, available_at)
      values ($1, $2, 'delete-request-0001', now() + interval '30 days', now() + interval '30 days')`,
    [deletionId, userId]);
    expect((await client.query("select count(*)::int as count from sessions where user_id=$1", [userId])).rows[0]).toEqual({ count: 0 });
    expect((await client.query("select discoverable from profiles where user_id=$1", [userId])).rows[0]).toEqual({ discoverable: false });
    expect((await client.query(`select status,attempts,available_at=execute_at as available_aligned,
      lease_id is null and lease_expires_at is null and last_error_code is null and manual_review_at is null
        and canceled_at is null and completed_at is null as worker_fields_clear,
      original_profile_discoverable,cancellation_token_hash ~ '^[a-f0-9]{64}$' as token_shape,
      cancellation_token_expires_at=execute_at as token_expiry_aligned
      from account_deletion_requests where id=$1`, [deletionId])).rows[0]).toEqual({ status: "cooling_off",
      attempts: 0, available_aligned: true, worker_fields_clear: true, original_profile_discoverable: true,
      token_shape: true, token_expiry_aligned: true });
    expect((await client.query("select event_type from privacy_workflow_outbox where deletion_request_id=$1 order by event_type", [deletionId]))
      .rows.map((row) => (row as { event_type: string }).event_type)).toEqual(["deletion_requested", "renewal_cancel_requested"]);
  });

  it("prevents session and discovery bypass while cooling off", async () => {
    const userId = await user();
    await client.query(`insert into account_deletion_requests
      (user_id, idempotency_key, execute_at, available_at)
      values ($1, 'delete-request-0002', now() + interval '30 days', now() + interval '30 days')`, [userId]);
    await expect(client.query("insert into sessions (expires_at, token, user_id) values (now() + interval '1 day', 'new-token', $1)", [userId]))
      .rejects.toThrow("ACCOUNT_DELETION_IN_PROGRESS");
    await expect(client.query("update profiles set discoverable=true where user_id=$1", [userId]))
      .rejects.toThrow("ACCOUNT_DELETION_IN_PROGRESS");
  });

  it("keeps restricted retention records append-only", async () => {
    const userId = await user();
    const deletionId = crypto.randomUUID();
    await client.query(`insert into account_deletion_requests
      (id, user_id, idempotency_key, execute_at, available_at)
      values ($1, $2, 'delete-request-0003', now() + interval '30 days', now() + interval '30 days')`, [deletionId, userId]);
    const ledgerId = crypto.randomUUID();
    await client.query(`insert into privacy_retention_ledger
      (id, deletion_request_id, user_id, record_type, record_id, legal_basis, restricted_locator)
      values ($1,$2,$3,'moderation_case','case-1','moderation','{"vault":"restricted"}')`, [ledgerId, deletionId, userId]);
    await expect(client.query("delete from privacy_retention_ledger where id=$1", [ledgerId]))
      .rejects.toThrow("PRIVACY_RETENTION_LEDGER_APPEND_ONLY");
  });

  it("rejects direct cooling-window, available-time and processing-lease bypasses", async () => {
    const firstUser = await user();
    await expect(client.query(`insert into account_deletion_requests
      (user_id,idempotency_key,execute_at,available_at) values ($1,'delete-too-soon',now(),now())`, [firstUser]))
      .rejects.toThrow();
    const secondUser = await user();
    await expect(client.query(`insert into account_deletion_requests
      (user_id,idempotency_key,status,created_at,execute_at,available_at)
      values ($1,'delete-processing-null','processing',now()-interval '31 days',now()-interval '1 day',now())`, [secondUser]))
      .rejects.toThrow();
    const leasedUser = await user();
    await expect(client.query(`insert into account_deletion_requests
      (user_id,idempotency_key,status,attempts,created_at,execute_at,available_at,lease_id,lease_expires_at)
      values ($1,'delete-processing-leased','processing',0,now(),now()+interval '30 days',
        now()+interval '30 days',$2,now()+interval '30 days 5 minutes')`, [leasedUser, crypto.randomUUID()]))
      .rejects.toThrow("ACCOUNT_DELETION_INVALID_INITIAL_STATE");
    const failedShapeUser = await user();
    await expect(client.query(`insert into account_deletion_requests
      (user_id,idempotency_key,created_at,execute_at,available_at,last_error_code)
      values ($1,'delete-initial-error',now(),now()+interval '30 days',now()+interval '30 days','SHOULD_BE_NULL')`,
    [failedShapeUser])).rejects.toThrow("ACCOUNT_DELETION_INVALID_INITIAL_STATE");
    const thirdUser = await user();
    await expect(client.query(`insert into notification_outbox
      (user_id,dedupe_key,category,template_key,locale,channels,status)
      values ($1,'direct-notification-processing','transactional','privacy.exportReady','en',array['inApp'],'processing')`,
    [thirdUser])).rejects.toThrow();
    await expect(client.query(`insert into privacy_export_jobs
      (user_id,idempotency_key,status) values ($1,'direct-export-processing','processing')`, [thirdUser]))
      .rejects.toThrow();
    const exportId = crypto.randomUUID();
    await expect(client.query(`insert into privacy_export_jobs
      (id,user_id,idempotency_key,cleanup_status) values ($1,$2,'direct-cleanup-processing','processing')`,
    [exportId, thirdUser])).rejects.toThrow();
    const fourthUser = await user();
    await client.query(`insert into account_deletion_requests
      (user_id,idempotency_key,execute_at,available_at) values
      ($1,'workflow-lease-shape',now()+interval '30 days',now()+interval '30 days')`, [fourthUser]);
    await expect(client.query(`update privacy_workflow_outbox set status='processing'
      where user_id=$1 and event_type='deletion_requested'`, [fourthUser])).rejects.toThrow();
  });

  it("atomically claims renewal and notification workflow events with lease recovery", async () => {
    const userId = await user();
    const deletionId = crypto.randomUUID();
    await client.query(`insert into account_deletion_requests
      (id, user_id, idempotency_key, execute_at, available_at)
      values ($1, $2, 'delete-request-worker', now() + interval '30 days', now() + interval '30 days')`,
    [deletionId, userId]);
    await client.query(`update privacy_workflow_outbox set status='processing', lease_id=$1,
      lease_expires_at=$2 where deletion_request_id=$3 and event_type='renewal_cancel_requested'`,
    [crypto.randomUUID(), new Date("2026-08-20T15:59:00Z"), deletionId]);
    const store = new DrizzlePrivacyWorkflowStore(drizzle(client, { schema }) as never,
      () => new Date("2026-08-20T16:00:00Z"));

    const job = await store.claim();
    expect(job).toMatchObject({ userId, deletionRequestId: deletionId, eventType: "renewal_cancel_requested", attempts: 1 });
    await store.complete(job!.id, job!.leaseId);
    expect((await client.query("select status from privacy_workflow_outbox where id=$1", [job!.id])).rows[0])
      .toEqual({ status: "done" });
    await client.query(`update privacy_workflow_outbox set available_at=$1
      where deletion_request_id=$2 and event_type='deletion_requested'`,
    [new Date("2026-08-20T15:58:00Z"), deletionId]);
    const notificationJob = await store.claim();
    expect(notificationJob).toMatchObject({ deletionRequestId: deletionId, eventType: "deletion_requested" });
    await store.handleNotification(notificationJob!);
    await store.complete(notificationJob!.id, notificationJob!.leaseId);
    expect((await client.query("select template_key from notification_outbox where user_id=$1", [userId])).rows)
      .toEqual([{ template_key: "privacy.deletionCoolingOff" }]);
  });

  it("defers deletion without consuming an attempt until the webhook projection confirms cancellation", async () => {
    const userId = await user();
    const subscriptionId = await activeSubscription(userId);
    const deletionId = crypto.randomUUID();
    await client.query(`insert into account_deletion_requests
      (id, user_id, idempotency_key, created_at, execute_at, available_at)
      values ($1, $2, 'delete-authoritative-gate', now() - interval '31 days',
        now() - interval '1 minute', now() - interval '1 minute')`,
    [deletionId, userId]);
    await client.query(`insert into billing_subscription_intents
      (user_id, subscription_id, idempotency_key, request_hash, action, status)
      values ($1, $2, 'privacy-delete-provider-submitted', repeat('a', 64), 'cancel_at_period_end', 'provider_submitted')`,
    [userId, subscriptionId]);
    const store = new DrizzleDeletionWorkerStore(drizzle(client, { schema }) as never);

    expect(await store.claim()).toBeNull();
    expect((await client.query("select status, attempts from account_deletion_requests where id=$1", [deletionId])).rows[0])
      .toEqual({ status: "cooling_off", attempts: 0 });

    await client.query("update billing_subscriptions set cancel_at_period_end=true where id=$1", [subscriptionId]);
    await client.query("update account_deletion_requests set available_at=now() - interval '1 second' where id=$1", [deletionId]);
    expect(await store.claim()).toMatchObject({ id: deletionId, userId, attempts: 1, leaseId: expect.any(String) });
  });

  it("fences destructive and terminal writes from a recovered deletion lease", async () => {
    const userId = await user();
    const deletionId = crypto.randomUUID();
    await client.query(`insert into account_deletion_requests
      (id, user_id, idempotency_key, created_at, execute_at, available_at)
      values ($1, $2, 'delete-lease-fencing', now() - interval '31 days',
        now() - interval '1 minute', now() - interval '1 minute')`,
    [deletionId, userId]);
    const store = new DrizzleDeletionWorkerStore(drizzle(client, { schema }) as never);
    const leaseA = await store.claim();
    expect(leaseA).toMatchObject({ id: deletionId, leaseId: expect.any(String) });
    await client.query("update account_deletion_requests set lease_expires_at=now() - interval '1 second' where id=$1", [deletionId]);
    const leaseB = await store.claim();
    expect(leaseB).toMatchObject({ id: deletionId, leaseId: expect.any(String) });
    expect(leaseB!.leaseId).not.toBe(leaseA!.leaseId);

    await expect(store.anonymizeEligible(leaseA!)).rejects.toThrow("DELETION_LEASE_LOST");
    expect((await client.query("select name from users where id=$1", [userId])).rows[0]).toEqual({ name: "Owner" });

    await store.retainRestricted(leaseB!);
    await store.anonymizeEligible(leaseB!);
    await store.complete(leaseB!);
    await expect(store.retry(leaseA!, { errorCode: "DELETION_FAILED", availableAt: new Date() }))
      .rejects.toThrow("DELETION_LEASE_LOST");
    await expect(store.manualReview(leaseA!, "DELETION_FAILED")).rejects.toThrow("DELETION_LEASE_LOST");
    expect((await client.query("select status from account_deletion_requests where id=$1", [deletionId])).rows[0])
      .toEqual({ status: "completed" });
  });

  it("fences generation and independent cleanup leases while completing ready and outbox atomically", async () => {
    const userId = await user();
    const exportId = crypto.randomUUID();
    await client.query(`insert into privacy_export_jobs (id,user_id,idempotency_key,available_at)
      values ($1,$2,'export-lease-fencing',now() - interval '1 minute')`, [exportId, userId]);
    const secureDownloads: Array<{ token: string; jobId: string }> = [];
    const store = new DrizzlePrivacyExportWorkerStore(drizzle(client, { schema }) as never, undefined,
      async (_transaction, delivery) => { secureDownloads.push(delivery); });
    const leaseA = await store.claim();
    expect(leaseA).toMatchObject({ id: exportId, leaseId: expect.any(String) });
    const identity = await store.prepareArtifact(leaseA!, { objectKey: `privacy/${exportId}.enc`,
      encryptionKeyId: "key-v1", expiresAt: new Date(Date.now() + 60_000) });
    await client.query("update privacy_export_jobs set lease_expires_at=now() - interval '1 second' where id=$1", [exportId]);
    const leaseB = await store.claim();
    await expect(store.complete({ ...identity, id: exportId, leaseId: leaseA!.leaseId, objectVersion: "version-a",
      integritySha256: "a".repeat(64), completedAt: new Date() })).rejects.toThrow("EXPORT_LEASE_LOST");
    await store.complete({ ...identity, id: exportId, leaseId: leaseB!.leaseId, objectVersion: "version-b",
      integritySha256: "b".repeat(64), completedAt: new Date() });
    expect((await client.query("select status from privacy_export_jobs where id=$1", [exportId])).rows[0])
      .toEqual({ status: "ready" });
    expect(secureDownloads).toEqual([expect.objectContaining({ jobId: exportId,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) })]);
    const credential = (await client.query(`select download_token_hash,download_token_expires_at
      from privacy_export_jobs where id=$1`, [exportId])).rows[0] as Record<string, unknown>;
    expect(credential.download_token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(credential.download_token_hash).not.toBe(secureDownloads[0]!.token);
    expect((await client.query("select count(*)::int as count from privacy_workflow_outbox where export_job_id=$1 and event_type='export_ready'",
      [exportId])).rows[0]).toEqual({ count: 1 });

    await client.query(`update privacy_export_jobs set expires_at=now() - interval '1 second',
      cleanup_available_at=now() - interval '1 second' where id=$1`, [exportId]);
    const cleanupA = await store.claimExpired();
    expect(cleanupA).toMatchObject({ id: exportId, leaseId: expect.any(String), attempts: 1 });
    await client.query("update privacy_export_jobs set cleanup_lease_expires_at=now() - interval '1 second' where id=$1", [exportId]);
    const cleanupB = await store.claimExpired();
    await expect(store.markExpired(cleanupA!)).rejects.toThrow("EXPORT_CLEANUP_LEASE_LOST");
    await store.markExpired(cleanupB!);
    expect((await client.query("select status,cleanup_status,attempts,cleanup_attempts from privacy_export_jobs where id=$1",
      [exportId])).rows[0]).toEqual({ status: "expired", cleanup_status: "completed", attempts: 2, cleanup_attempts: 2 });
  });

  it("recomputes billing retention and removes eligible auth and notification secrets at execution", async () => {
    const userId = await user(); const subscriptionId = await activeSubscription(userId);
    await client.query("update billing_subscriptions set cancel_at_period_end=true where id=$1", [subscriptionId]);
    await client.query(`insert into two_factors (secret,backup_codes,user_id) values ('totp-secret','backup-secret',$1)`, [userId]);
    await client.query(`insert into notification_preferences (user_id,locale,time_zone)
      values ($1,'zh-CN','Asia/Shanghai')`, [userId]);
    const deletionId = crypto.randomUUID();
    await client.query(`insert into account_deletion_requests
      (id,user_id,idempotency_key,created_at,execute_at,available_at)
      values ($1,$2,'delete-retention-recompute',now()-interval '31 days',
        now()-interval '1 second',now()-interval '1 second')`,
    [deletionId, userId]);
    const store = new DrizzleDeletionWorkerStore(drizzle(client, { schema }) as never);
    const job = await store.claim();
    await store.retainRestricted(job!); await store.anonymizeEligible(job!); await store.complete(job!);
    expect((await client.query(`select record_type,record_id from privacy_retention_ledger
      where deletion_request_id=$1`, [deletionId])).rows).toContainEqual({ record_type: "billing_subscription",
      record_id: subscriptionId });
    expect((await client.query("select count(*)::int as count from two_factors where user_id=$1", [userId])).rows[0])
      .toEqual({ count: 0 });
    expect((await client.query("select count(*)::int as count from notification_preferences where user_id=$1", [userId])).rows[0])
      .toEqual({ count: 0 });
  });

  it("preserves only a held message referenced by owned moderation evidence", async () => {
    const ownerId = await user();
    const peerId = await user();
    const [lowUserId, highUserId] = [ownerId, peerId].sort();
    const conversationId = crypto.randomUUID();
    await client.query(`insert into conversations (id,low_user_id,high_user_id,next_sequence)
      values ($1,$2,$3,3)`, [conversationId, lowUserId, highUserId]);
    for (const memberId of [ownerId, peerId]) await client.query(`insert into conversation_members
      (conversation_id,user_id,low_user_id,high_user_id) values ($1,$2,$3,$4)`,
    [conversationId, memberId, lowUserId, highUserId]);
    const heldMessageId = crypto.randomUUID(); const eligibleMessageId = crypto.randomUUID();
    await client.query(`insert into messages
      (id,conversation_id,low_user_id,high_user_id,sequence,sender_user_id,client_id,body)
      values ($1,$2,$3,$4,1,$5,$6,'held body'),($7,$2,$3,$4,2,$5,$8,'eligible body')`,
    [heldMessageId, conversationId, lowUserId, highUserId, ownerId, crypto.randomUUID(),
      eligibleMessageId, crypto.randomUUID()]);
    const profile = (await client.query("select id from profiles where user_id=$1", [ownerId])).rows[0] as { id: string };
    const reportId = crypto.randomUUID(); const caseId = crypto.randomUUID();
    await client.query(`insert into reports
      (id,reporter_user_id,target_user_id,target_profile_id,target_type,message_id,conversation_id,reason_code,locale,
       explanation,client_id,request_hash,dedupe_key,target_snapshot)
      values ($1,$2,$3,$4,'message',$5,$6,'HARASSMENT','en','evidence',$7,repeat('a',64),repeat('b',64),$8)`,
    [reportId, peerId, ownerId, profile.id, heldMessageId, conversationId, crypto.randomUUID(), JSON.stringify({
      schemaVersion: 1, targetType: "message", targetUserId: ownerId, targetProfileId: profile.id,
      capturedAt: new Date().toISOString(), displayName: "Owner", messageId: heldMessageId, conversationId,
    })]);
    await client.query("insert into moderation_cases (id,report_id) values ($1,$2)", [caseId, reportId]);
    await client.query(`insert into moderation_evidence
      (report_id,case_id,kind,locator,integrity_sha256,preserve_until)
      values ($1,$2,'message_reference',$3,repeat('c',64),now()+interval '1 year')`,
    [reportId, caseId, JSON.stringify({ schemaVersion: 1, referenceType: "message",
      referenceId: heldMessageId, conversationId })]);
    const deletionId = crypto.randomUUID();
    await client.query(`insert into account_deletion_requests
      (id,user_id,idempotency_key,created_at,execute_at,available_at)
      values ($1,$2,'delete-held-message',now()-interval '31 days',now()-interval '1 second',now()-interval '1 second')`,
    [deletionId, ownerId]);
    const store = new DrizzleDeletionWorkerStore(drizzle(client, { schema }) as never);
    const job = await store.claim();
    await store.retainRestricted(job!); await store.anonymizeEligible(job!);
    expect((await client.query("select id,body from messages where id=any($1) order by body", [[heldMessageId, eligibleMessageId]])).rows)
      .toEqual([{ id: eligibleMessageId, body: "[deleted]" }, { id: heldMessageId, body: "held body" }]);
  });
});
