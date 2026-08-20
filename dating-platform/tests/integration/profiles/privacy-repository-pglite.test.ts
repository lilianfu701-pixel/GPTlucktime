import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzlePrivacyRepository } from "@/modules/profiles/privacy-repository";
import { DrizzlePrivacyWorkflowStore } from "@/modules/profiles/privacy-worker-store";

describe("DrizzlePrivacyRepository", () => {
  let client: PGlite;
  let repository: DrizzlePrivacyRepository;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;
  const secureDeliveries: Array<{ token: string; userId: string; expiresAt: Date }> = [];

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "drizzle" });
    secureDeliveries.length = 0;
    repository = new DrizzlePrivacyRepository(database as never, () => new Date("2026-08-05T00:00:00Z"),
      async (_transaction, delivery) => { secureDeliveries.push(delivery); });
    userId = crypto.randomUUID();
    await database.insert(schema.users).values({ id: userId, name: "Owner", email: `${userId}@example.test` });
    await database.insert(schema.profiles).values({ userId, status: "active", discoverable: true });
  }, 30_000);

  afterEach(async () => client.close());

  it("converges concurrent export requests on one durable job", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => repository.createOrGetExport({
      userId, idempotencyKey: "export-request-0001", requestedAt: new Date("2026-08-05T00:00:00Z"),
    })));
    expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const [job] = await database.select().from(schema.privacyExportJobs);
    expect(await database.select().from(schema.notificationOutbox)).toHaveLength(0);
    expect(await database.select().from(schema.privacyWorkflowOutbox)).toHaveLength(1);
    await repository.createOrGetExport({ userId, idempotencyKey: "export-request-0001",
      requestedAt: new Date("2026-08-05T00:00:00Z") });
    expect(await database.select().from(schema.notificationOutbox)).toHaveLength(0);
    expect((await database.select().from(schema.privacyWorkflowOutbox))[0]).toMatchObject({ exportJobId: job.id });
    const workflow = new DrizzlePrivacyWorkflowStore(database as never, () => new Date("2026-08-05T00:01:00Z"));
    const event = await workflow.claim();
    await workflow.handleNotification(event!); await workflow.complete(event!.id, event!.leaseId);
    expect(await database.select().from(schema.notificationOutbox)).toHaveLength(1);
    await repository.createOrGetExport({ userId, idempotencyKey: "export-request-0001",
      requestedAt: new Date("2026-08-05T00:02:00Z") });
    expect(await database.select().from(schema.notificationOutbox)).toHaveLength(1);
  });

  it("replays one deletion request and cancels only during cooling off", async () => {
    const input = { userId, idempotencyKey: "delete-request-0001", executeAt: new Date("2026-09-04T00:00:00Z"),
      preserveHeldRecords: false };
    const first = await repository.beginDeletion(input);
    expect(await database.select().from(schema.notificationOutbox)).toHaveLength(0);
    const replay = await repository.beginDeletion(input);
    expect(replay).toEqual({ ...first, cancellationToken: null, replayed: true });
    expect(first.cancellationToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const [stored] = await database.select().from(schema.accountDeletionRequests);
    expect(stored.cancellationTokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.cancellationTokenHash).not.toBe(first.cancellationToken);
    expect(secureDeliveries).toEqual([expect.objectContaining({ token: first.cancellationToken, userId,
      recipient: `${userId}@example.test`, locale: "en",
      expiresAt: new Date("2026-09-04T00:00:00Z") })]);
    expect(JSON.stringify(await database.select().from(schema.notificationOutbox))).not.toContain(first.cancellationToken);
    await expect(repository.authenticateCancellationCredential({ token: first.cancellationToken!,
      now: new Date("2026-08-05T00:00:00Z") })).resolves.toEqual({ userId });
    await expect(repository.authenticateCancellationCredential({ token: "x".repeat(43),
      now: new Date("2026-08-05T00:00:00Z") })).resolves.toBeNull();
    await expect(repository.cancelDeletion({ token: first.cancellationToken!, idempotencyKey: "cancel-request-0001" }))
      .resolves.toEqual({ idempotencyKey: "cancel-request-0001", canceled: true });
    expect((await database.select().from(schema.profiles))[0]).toMatchObject({ userId, discoverable: true });
    await expect(repository.cancelDeletion({ token: first.cancellationToken!, idempotencyKey: "cancel-request-0001" }))
      .rejects.toThrow("DELETION_NOT_CANCELABLE");
  });

  it("fences a one-time download reservation across retry, lease recovery, and concurrent claims", async () => {
    const token = "d".repeat(43); const now = new Date();
    const [job] = await database.insert(schema.privacyExportJobs).values({ userId,
      idempotencyKey: "export-download-owner", status: "ready", objectKey: `privacy/${userId}/export.enc`,
      objectVersion: "version-1", integritySha256: "a".repeat(64), encryptionKeyId: "privacy-export-v1",
      expiresAt: new Date(now.getTime() + 86_400_000), completedAt: now,
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: new Date(now.getTime() + 15 * 60_000) }).returning();
    const otherUserId = crypto.randomUUID();
    await database.insert(schema.users).values({ id: otherUserId, name: "Other", email: `${otherUserId}@example.test` });
    await expect(repository.claimDownload({ userId: otherUserId, jobId: job.id, token, now })).resolves.toBeNull();
    await expect(repository.claimDownload({ userId, jobId: job.id, token: "x".repeat(43), now })).resolves.toBeNull();
    const concurrent = await Promise.all([repository.claimDownload({ userId, jobId: job.id, token, now }),
      repository.claimDownload({ userId, jobId: job.id, token, now })]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    const concurrentWinner = concurrent.find(Boolean)!;
    await expect(repository.releaseDownload(concurrentWinner)).resolves.toBe(true);

    const leaseA = await repository.claimDownload({ userId, jobId: job.id, token, now });
    expect(leaseA).toMatchObject({ ownerId: userId, objectVersion: "version-1", leaseId: expect.any(String) });
    await database.update(schema.privacyExportJobs).set({ downloadLeaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.privacyExportJobs.id, job.id));
    const leaseB = await repository.claimDownload({ userId, jobId: job.id, token, now });
    expect(leaseB!.leaseId).not.toBe(leaseA!.leaseId);
    await expect(repository.completeDownload(leaseA!)).resolves.toBe(false);
    await expect(repository.releaseDownload(leaseA!)).resolves.toBe(false);
    await expect(repository.completeDownload(leaseB!)).resolves.toBe(true);
    await expect(repository.claimDownload({ userId, jobId: job.id, token, now })).resolves.toBeNull();
    expect((await database.select({ usedAt: schema.privacyExportJobs.downloadTokenUsedAt,
      leaseId: schema.privacyExportJobs.downloadLeaseId }).from(schema.privacyExportJobs)
      .where(eq(schema.privacyExportJobs.id, job.id)))[0]).toMatchObject({ usedAt: expect.any(Date), leaseId: null });
    await expect(client.query("update privacy_export_jobs set download_token_used_at=null where id=$1", [job.id]))
      .rejects.toThrow("PRIVACY_EXPORT_DOWNLOAD_ALREADY_USED");

    await expect(client.query(`insert into privacy_export_jobs
      (user_id,idempotency_key,status,object_key,object_version,integrity_sha256,encryption_key_id,
       expires_at,completed_at,download_token_hash,download_token_expires_at,download_lease_id,download_lease_expires_at)
      values ($1,'export-direct-reservation','ready',$2,'version-direct',repeat('e',64),'privacy-export-v1',
        $3,$4,repeat('f',64),$5,$6,$7)`, [userId, `privacy/${userId}/direct.enc`,
      new Date(now.getTime() + 86_400_000), now, new Date(now.getTime() + 15 * 60_000),
      crypto.randomUUID(), new Date(now.getTime() + 120_000)]))
      .rejects.toThrow("PRIVACY_EXPORT_DOWNLOAD_LEASE_STALE");
  });

  it("releases a failed artifact read, completes one retry, and then permanently rejects the token", async () => {
    const token = "r".repeat(43); const now = new Date();
    const [job] = await database.insert(schema.privacyExportJobs).values({ userId,
      idempotencyKey: "export-download-retry", status: "ready", objectKey: `privacy/${userId}/retry.enc`,
      objectVersion: "version-retry", integritySha256: "c".repeat(64), encryptionKeyId: "privacy-export-v1",
      expiresAt: new Date(now.getTime() + 86_400_000), completedAt: now,
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: new Date(now.getTime() + 15 * 60_000) }).returning();
    const failedReadLease = await repository.claimDownload({ userId, jobId: job.id, token, now });
    expect(failedReadLease).toMatchObject({ leaseId: expect.any(String) });
    await expect(repository.releaseDownload(failedReadLease!)).resolves.toBe(true);
    const retryLease = await repository.claimDownload({ userId, jobId: job.id, token, now });
    await expect(repository.completeDownload(retryLease!)).resolves.toBe(true);
    await expect(repository.claimDownload({ userId, jobId: job.id, token, now })).resolves.toBeNull();
  });
});
