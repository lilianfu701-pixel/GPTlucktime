import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";

import { accountDeletionRequests, accounts, billingSubscriptions, privacyAuditEvents, privacyExportJobs, privacySettings, privacyWorkflowOutbox,
  notificationPreferences, profilePhotoUploads, profilePreferences, profiles, sessions, twoFactors, users } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import type { DeletionJob } from "./deletion-service";
import { enqueueProductionNotification } from "@/modules/notifications/notification-producer";

type PrivacyDatabase = typeof productionDatabase;

export class DrizzlePrivacyExportWorkerStore {
  private readonly database: PrivacyDatabase;
  constructor(database: unknown, private readonly clock: () => Date = () => new Date(),
    private readonly enqueueSecureDownload?: (transaction: unknown, input: { userId: string; recipient: string;
      locale: "en" | "zh-CN"; token: string; jobId: string; expiresAt: Date }) => Promise<void>) {
    this.database = database as PrivacyDatabase;
  }
  async claim() {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase; const now = this.clock();
      const [row] = await tx.select().from(privacyExportJobs).where(and(lt(privacyExportJobs.attempts, 5),
        or(and(eq(privacyExportJobs.status, "pending"), lte(privacyExportJobs.availableAt, now)),
          and(eq(privacyExportJobs.status, "processing"), lte(privacyExportJobs.leaseExpiresAt, now)))))
        .orderBy(asc(privacyExportJobs.availableAt), asc(privacyExportJobs.id)).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      const leaseId = randomUUID();
      const [claimed] = await tx.update(privacyExportJobs).set({ status: "processing", attempts: row.attempts + 1,
        leaseId, leaseExpiresAt: new Date(now.getTime() + 5 * 60_000), updatedAt: now })
        .where(eq(privacyExportJobs.id, row.id)).returning();
      return claimed ? { id: claimed.id, leaseId, userId: claimed.userId, attempts: claimed.attempts } : null;
    });
  }

  private async assertActiveLease(transaction: PrivacyDatabase, job: { id: string; leaseId: string }) {
    const [leased] = await transaction.select({ id: privacyExportJobs.id }).from(privacyExportJobs).where(and(
      eq(privacyExportJobs.id, job.id), eq(privacyExportJobs.status, "processing"),
      eq(privacyExportJobs.leaseId, job.leaseId), gt(privacyExportJobs.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
    )).limit(1).for("update");
    if (!leased) throw new Error("EXPORT_LEASE_LOST");
  }

  async prepareArtifact(job: { id: string; leaseId: string }, input: { objectKey: string; encryptionKeyId: string;
    expiresAt: Date }): Promise<{ objectKey: string; encryptionKeyId: string; expiresAt: Date;
      preparedArtifactEncrypted?: string; preparedIntegritySha256?: string }> {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      await this.assertActiveLease(tx, job);
      const [row] = await tx.select({ objectKey: privacyExportJobs.objectKey,
        encryptionKeyId: privacyExportJobs.encryptionKeyId, expiresAt: privacyExportJobs.expiresAt,
        preparedArtifactEncrypted: privacyExportJobs.preparedArtifactEncrypted,
        preparedIntegritySha256: privacyExportJobs.preparedIntegritySha256 })
        .from(privacyExportJobs).where(eq(privacyExportJobs.id, job.id)).limit(1);
      if (row?.objectKey && row.encryptionKeyId && row.expiresAt) return {
        objectKey: row.objectKey, encryptionKeyId: row.encryptionKeyId, expiresAt: row.expiresAt,
        ...(row.preparedArtifactEncrypted && row.preparedIntegritySha256 ? {
          preparedArtifactEncrypted: row.preparedArtifactEncrypted,
          preparedIntegritySha256: row.preparedIntegritySha256,
        } : {}),
      };
      const [prepared] = await tx.update(privacyExportJobs).set({ objectKey: input.objectKey,
        encryptionKeyId: input.encryptionKeyId, expiresAt: input.expiresAt, updatedAt: this.clock() })
        .where(and(eq(privacyExportJobs.id, job.id), eq(privacyExportJobs.leaseId, job.leaseId),
          eq(privacyExportJobs.status, "processing"))).returning({ objectKey: privacyExportJobs.objectKey,
          encryptionKeyId: privacyExportJobs.encryptionKeyId, expiresAt: privacyExportJobs.expiresAt });
      if (!prepared?.objectKey || !prepared.encryptionKeyId || !prepared.expiresAt) throw new Error("EXPORT_LEASE_LOST");
      return prepared as { objectKey: string; encryptionKeyId: string; expiresAt: Date };
    });
  }

  async prepareEncryptedArtifact(job: { id: string; leaseId: string }, input: {
    bodyBase64: string; integritySha256: string;
  }) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      await this.assertActiveLease(tx, job);
      const [row] = await tx.select({ body: privacyExportJobs.preparedArtifactEncrypted,
        hash: privacyExportJobs.preparedIntegritySha256 }).from(privacyExportJobs)
        .where(eq(privacyExportJobs.id, job.id)).limit(1);
      if (row?.body && row.hash) return { bodyBase64: row.body, integritySha256: row.hash };
      const [prepared] = await tx.update(privacyExportJobs).set({ preparedArtifactEncrypted: input.bodyBase64,
        preparedIntegritySha256: input.integritySha256, updatedAt: this.clock() })
        .where(and(eq(privacyExportJobs.id, job.id), eq(privacyExportJobs.status, "processing"),
          eq(privacyExportJobs.leaseId, job.leaseId), sql`${privacyExportJobs.preparedArtifactEncrypted} IS NULL`))
        .returning({ body: privacyExportJobs.preparedArtifactEncrypted,
          hash: privacyExportJobs.preparedIntegritySha256 });
      if (!prepared?.body || !prepared.hash) throw new Error("EXPORT_LEASE_LOST");
      return { bodyBase64: prepared.body, integritySha256: prepared.hash };
    });
  }

  async complete(input: { id: string; leaseId: string; objectKey: string; objectVersion: string; integritySha256: string;
    encryptionKeyId: string; expiresAt: Date; completedAt: Date }) {
    const downloadToken = randomBytes(32).toString("base64url");
    const downloadTokenHash = createHash("sha256").update(downloadToken).digest("hex");
    const downloadTokenExpiresAt = new Date(Math.min(input.expiresAt.getTime(), input.completedAt.getTime() + 15 * 60_000));
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      await this.assertActiveLease(tx, input);
      const rows = await tx.update(privacyExportJobs).set({ status: "ready", objectKey: input.objectKey,
        objectVersion: input.objectVersion, integritySha256: input.integritySha256, encryptionKeyId: input.encryptionKeyId,
        expiresAt: input.expiresAt, completedAt: input.completedAt, cleanupAvailableAt: input.expiresAt,
        preparedArtifactEncrypted: null, downloadTokenHash, downloadTokenExpiresAt,
        leaseId: null, leaseExpiresAt: null, updatedAt: input.completedAt }).where(and(eq(privacyExportJobs.id, input.id),
        eq(privacyExportJobs.status, "processing"), eq(privacyExportJobs.leaseId, input.leaseId)))
        .returning({ userId: privacyExportJobs.userId });
      if (rows.length !== 1) throw new Error("EXPORT_LEASE_LOST");
      if (this.enqueueSecureDownload) {
        const [owner] = await tx.select({ email: users.email, locale: notificationPreferences.locale }).from(users)
          .leftJoin(notificationPreferences, eq(notificationPreferences.userId, users.id))
          .where(eq(users.id, rows[0]!.userId)).limit(1);
        if (!owner) throw new Error("EXPORT_OWNER_MISSING");
        await this.enqueueSecureDownload(tx, { userId: rows[0]!.userId, recipient: owner.email,
          locale: owner.locale === "zh-CN" ? "zh-CN" : "en", token: downloadToken, jobId: input.id,
          expiresAt: downloadTokenExpiresAt });
      }
      await tx.insert(privacyWorkflowOutbox).values({ userId: rows[0]!.userId, exportJobId: input.id,
        eventType: "export_ready", dedupeKey: `export-ready:${input.id}`, availableAt: input.completedAt,
        createdAt: input.completedAt }).onConflictDoNothing();
    });
  }
  async retry(job: { id: string; leaseId: string }, input: { errorCode: "EXPORT_FAILED"; availableAt: Date }) {
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase; await this.assertActiveLease(tx, job);
      await tx.update(privacyExportJobs).set({ status: "pending", availableAt: input.availableAt,
        lastErrorCode: input.errorCode, leaseId: null, leaseExpiresAt: null, updatedAt: this.clock() })
        .where(and(eq(privacyExportJobs.id, job.id), eq(privacyExportJobs.leaseId, job.leaseId),
          eq(privacyExportJobs.status, "processing")));
    });
  }
  async manualReview(job: { id: string; leaseId: string }, errorCode: "EXPORT_FAILED") {
    const now = this.clock(); await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase; await this.assertActiveLease(tx, job);
      await tx.update(privacyExportJobs).set({ status: "manual_review", lastErrorCode: errorCode, manualReviewAt: now,
        leaseId: null, leaseExpiresAt: null, updatedAt: now }).where(and(eq(privacyExportJobs.id, job.id),
        eq(privacyExportJobs.leaseId, job.leaseId), eq(privacyExportJobs.status, "processing")));
    });
  }
  async collect(userId: string) {
    const [account] = await this.database.select({ name: users.name, email: users.email, createdAt: users.createdAt })
      .from(users).where(eq(users.id, userId)).limit(1);
    const [profile] = await this.database.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
    const [preferences] = await this.database.select().from(profilePreferences)
      .where(eq(profilePreferences.userId, userId)).limit(1);
    const [privacy] = await this.database.select().from(privacySettings).where(eq(privacySettings.userId, userId)).limit(1);
    if (!account) throw new Error("EXPORT_OWNER_NOT_AVAILABLE");
    return { account, profile: profile ?? null, preferences: preferences ?? null, privacy: privacy ?? null };
  }
  async claimExpired() {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase; const now = this.clock();
      const [row] = await tx.select().from(privacyExportJobs).where(and(eq(privacyExportJobs.status, "ready"),
        lte(privacyExportJobs.expiresAt, now), lt(privacyExportJobs.cleanupAttempts, 5),
        or(and(eq(privacyExportJobs.cleanupStatus, "pending"), lte(privacyExportJobs.cleanupAvailableAt, now)),
          and(eq(privacyExportJobs.cleanupStatus, "processing"), lte(privacyExportJobs.cleanupLeaseExpiresAt, now)))))
        .orderBy(asc(privacyExportJobs.expiresAt), asc(privacyExportJobs.id)).limit(1)
        .for("update", { skipLocked: true });
      if (!row?.objectKey || !row.objectVersion) return null;
      const leaseId = randomUUID(); const attempts = row.cleanupAttempts + 1;
      await tx.update(privacyExportJobs).set({ cleanupStatus: "processing", cleanupAttempts: attempts,
        cleanupLeaseId: leaseId, cleanupLeaseExpiresAt: new Date(now.getTime() + 5 * 60_000), updatedAt: now })
        .where(eq(privacyExportJobs.id, row.id));
      return { id: row.id, leaseId, objectKey: row.objectKey, objectVersion: row.objectVersion, attempts };
    });
  }
  async markExpired(job: { id: string; leaseId: string }) {
    const rows = await this.database.update(privacyExportJobs).set({ status: "expired", cleanupStatus: "completed",
      downloadLeaseId: null, downloadLeaseExpiresAt: null,
      downloadTokenRevokedAt: sql`CASE WHEN ${privacyExportJobs.downloadTokenUsedAt} IS NULL
        THEN statement_timestamp() ELSE ${privacyExportJobs.downloadTokenRevokedAt} END`,
      cleanupLeaseId: null, cleanupLeaseExpiresAt: null, updatedAt: this.clock() })
      .where(and(eq(privacyExportJobs.id, job.id), eq(privacyExportJobs.status, "ready"),
        eq(privacyExportJobs.cleanupStatus, "processing"), eq(privacyExportJobs.cleanupLeaseId, job.leaseId),
        gt(privacyExportJobs.cleanupLeaseExpiresAt, sql`CURRENT_TIMESTAMP`))).returning({ id: privacyExportJobs.id });
    if (rows.length !== 1) throw new Error("EXPORT_CLEANUP_LEASE_LOST");
  }
  async failExpiredCleanup(job: { id: string; leaseId: string }, input: { attempts: number; availableAt: Date }) {
    const terminal = input.attempts >= 5;
    const rows = await this.database.update(privacyExportJobs).set({
      cleanupStatus: terminal ? "manual_review" : "pending", cleanupAttempts: input.attempts,
      cleanupAvailableAt: input.availableAt, cleanupLastErrorCode: "EXPORT_CLEANUP_FAILED",
      cleanupManualReviewAt: terminal ? this.clock() : null, cleanupLeaseId: null, cleanupLeaseExpiresAt: null,
      updatedAt: this.clock() }).where(and(eq(privacyExportJobs.id, job.id), eq(privacyExportJobs.status, "ready"),
      eq(privacyExportJobs.cleanupStatus, "processing"), eq(privacyExportJobs.cleanupLeaseId, job.leaseId),
      gt(privacyExportJobs.cleanupLeaseExpiresAt, sql`CURRENT_TIMESTAMP`))).returning({ id: privacyExportJobs.id });
    if (rows.length !== 1) throw new Error("EXPORT_CLEANUP_LEASE_LOST");
  }
}

export class DrizzlePrivacyWorkflowStore {
  private readonly database: PrivacyDatabase;
  constructor(database: unknown, private readonly clock: () => Date = () => new Date()) {
    this.database = database as PrivacyDatabase;
  }
  async claim() {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase; const now = this.clock();
      const [row] = await tx.select().from(privacyWorkflowOutbox).where(and(
        lt(privacyWorkflowOutbox.attempts, 5),
        or(and(eq(privacyWorkflowOutbox.status, "pending"), lte(privacyWorkflowOutbox.availableAt, now)),
          and(eq(privacyWorkflowOutbox.status, "processing"), lte(privacyWorkflowOutbox.leaseExpiresAt, now)))))
        .orderBy(asc(privacyWorkflowOutbox.availableAt), asc(privacyWorkflowOutbox.id)).limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const leaseId = randomUUID();
      const [claimed] = await tx.update(privacyWorkflowOutbox).set({ status: "processing", attempts: row.attempts + 1,
        leaseId, leaseExpiresAt: new Date(now.getTime() + 5 * 60_000) }).where(and(eq(privacyWorkflowOutbox.id, row.id),
        or(eq(privacyWorkflowOutbox.status, "pending"), eq(privacyWorkflowOutbox.status, "processing"))))
        .returning({ id: privacyWorkflowOutbox.id });
      return claimed ? { id: row.id, leaseId, userId: row.userId, deletionRequestId: row.deletionRequestId,
        exportJobId: row.exportJobId, eventType: row.eventType, attempts: row.attempts + 1 } : null;
    });
  }
  async handleNotification(job: { id: string; leaseId: string; userId: string; deletionRequestId: string | null;
    exportJobId: string | null; eventType: string }) {
    if (job.eventType === "renewal_cancel_requested") return;
    const now = this.clock();
    let templateKey: string; let payload: Record<string, string> = {};
    if (job.eventType === "export_requested" || job.eventType === "export_ready") {
      if (!job.exportJobId) throw new Error("WORKFLOW_EVENT_INVALID");
      const [record] = await this.database.select({ expiresAt: privacyExportJobs.expiresAt }).from(privacyExportJobs)
        .where(eq(privacyExportJobs.id, job.exportJobId)).limit(1);
      if (!record) throw new Error("WORKFLOW_EVENT_INVALID");
      templateKey = job.eventType === "export_ready" ? "privacy.exportReady" : "privacy.exportAccepted";
      payload = { jobId: job.exportJobId, ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}) };
    } else {
      if (!job.deletionRequestId) throw new Error("WORKFLOW_EVENT_INVALID");
      const [record] = await this.database.select({ executeAt: accountDeletionRequests.executeAt })
        .from(accountDeletionRequests).where(eq(accountDeletionRequests.id, job.deletionRequestId)).limit(1);
      if (!record) throw new Error("WORKFLOW_EVENT_INVALID");
      templateKey = job.eventType === "deletion_requested" ? "privacy.deletionCoolingOff"
        : job.eventType === "deletion_canceled" ? "privacy.deletionCanceled"
          : job.eventType === "deletion_completed" ? "privacy.deletionCompleted" : "";
      if (!templateKey) throw new Error("WORKFLOW_EVENT_INVALID");
      payload = { executeAt: record.executeAt.toISOString() };
    }
    await enqueueProductionNotification(this.database, { userId: job.userId,
      dedupeKey: `privacy:${job.exportJobId ?? job.deletionRequestId}:${templateKey}`,
      category: "security", templateKey, payload,
      preferredChannels: job.eventType === "deletion_completed" ? ["inApp"] : undefined, availableAt: now });
  }
  async complete(id: string, leaseId: string) {
    await this.database.update(privacyWorkflowOutbox).set({ status: "done", leaseId: null, leaseExpiresAt: null })
      .where(and(eq(privacyWorkflowOutbox.id, id), eq(privacyWorkflowOutbox.leaseId, leaseId),
        eq(privacyWorkflowOutbox.status, "processing")));
  }
  async retry(id: string, leaseId: string, input: { errorCode: "WORKFLOW_FAILED"; availableAt: Date }) {
    void input.errorCode;
    await this.database.update(privacyWorkflowOutbox).set({ status: "pending", availableAt: input.availableAt,
      leaseId: null, leaseExpiresAt: null }).where(and(eq(privacyWorkflowOutbox.id, id),
      eq(privacyWorkflowOutbox.leaseId, leaseId), eq(privacyWorkflowOutbox.status, "processing")));
  }
  async manualReview(id: string, leaseId: string, errorCode: "WORKFLOW_FAILED") {
    void errorCode;
    await this.database.update(privacyWorkflowOutbox).set({ status: "manual_review", manualReviewAt: this.clock(),
      leaseId: null, leaseExpiresAt: null }).where(and(eq(privacyWorkflowOutbox.id, id),
      eq(privacyWorkflowOutbox.leaseId, leaseId), eq(privacyWorkflowOutbox.status, "processing")));
  }
}

export class DrizzleDeletionWorkerStore {
  private readonly database: PrivacyDatabase;
  constructor(database: unknown, private readonly clock: () => Date = () => new Date()) {
    this.database = database as PrivacyDatabase;
  }
  async claim() {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase; const now = this.clock();
      const rows = await tx.select().from(accountDeletionRequests).where(and(lt(accountDeletionRequests.attempts, 5),
        or(and(eq(accountDeletionRequests.status, "cooling_off"), lte(accountDeletionRequests.availableAt, now)),
          and(eq(accountDeletionRequests.status, "processing"), lte(accountDeletionRequests.leaseExpiresAt, now)))))
        .orderBy(asc(accountDeletionRequests.availableAt), asc(accountDeletionRequests.id)).limit(20)
        .for("update", { skipLocked: true });
      for (const row of rows) {
        const [blockingSubscription] = await tx.select({ id: billingSubscriptions.id }).from(billingSubscriptions)
          .where(and(eq(billingSubscriptions.userId, row.userId),
            inArray(billingSubscriptions.status, ["trialing", "active", "past_due", "grace_period", "disputed"]),
            eq(billingSubscriptions.cancelAtPeriodEnd, false))).limit(1);
        if (blockingSubscription) {
          await tx.update(accountDeletionRequests).set({ availableAt: new Date(now.getTime() + 5 * 60_000), updatedAt: now })
            .where(and(eq(accountDeletionRequests.id, row.id), eq(accountDeletionRequests.status, row.status)));
          continue;
        }
        const leaseId = randomUUID();
        const [claimed] = await tx.update(accountDeletionRequests).set({ status: "processing", attempts: row.attempts + 1,
          leaseId, leaseExpiresAt: new Date(now.getTime() + 5 * 60_000), updatedAt: now })
          .where(and(eq(accountDeletionRequests.id, row.id), eq(accountDeletionRequests.status, row.status))).returning();
        if (claimed) return { id: claimed.id, leaseId, userId: claimed.userId,
          preserveHeldRecords: claimed.preserveHeldRecords, attempts: claimed.attempts };
      }
      return null;
    });
  }

  private async assertActiveLease(transaction: PrivacyDatabase, job: Pick<DeletionJob, "id" | "leaseId">) {
    const [leased] = await transaction.select({ id: accountDeletionRequests.id }).from(accountDeletionRequests)
      .where(and(eq(accountDeletionRequests.id, job.id), eq(accountDeletionRequests.status, "processing"),
        eq(accountDeletionRequests.leaseId, job.leaseId), gt(accountDeletionRequests.leaseExpiresAt, sql`CURRENT_TIMESTAMP`)))
      .limit(1).for("update");
    if (!leased) throw new Error("DELETION_LEASE_LOST");
  }

  async retainRestricted(job: DeletionJob) {
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      await this.assertActiveLease(tx, job);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator,preserve_until)
        select ${job.id}, ${job.userId}, 'moderation_media_hold', id::text, 'legal_hold',
          jsonb_build_object('scope','moderation_vault','holdId',id::text), preserve_until
        from moderation_media_holds where subject_user_id=${job.userId} and active=true
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'billing_order', id::text, 'billing_ledger',
          jsonb_build_object('scope','billing_ledger','orderId',id::text)
        from billing_orders where user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'billing_subscription', id::text, 'billing_ledger',
          jsonb_build_object('scope','billing_ledger','subscriptionId',id::text)
        from billing_subscriptions where user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'billing_payment', p.id::text, 'billing_ledger',
          jsonb_build_object('scope','billing_ledger','paymentId',p.id::text)
        from billing_payments p left join billing_subscriptions s on s.id=p.subscription_id
        left join billing_orders o on o.id=p.order_id where s.user_id=${job.userId} or o.user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'billing_dispute', id::text, 'billing_ledger',
          jsonb_build_object('scope','billing_ledger','disputeId',id::text)
        from billing_disputes where user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'moderation_report', id::text, 'moderation',
          jsonb_build_object('scope','moderation_vault','reportId',id::text)
        from reports where target_user_id=${job.userId} or reporter_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'moderation_case', c.id::text, 'moderation',
          jsonb_build_object('scope','moderation_vault','caseId',c.id::text)
        from moderation_cases c join reports r on r.id=c.report_id
        where r.target_user_id=${job.userId} or r.reporter_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator,preserve_until)
        select ${job.id}, ${job.userId}, 'moderation_evidence', e.id::text, 'legal_hold',
          jsonb_build_object('scope','moderation_vault','evidenceId',e.id::text), e.preserve_until
        from moderation_evidence e join reports r on r.id=e.report_id
        where r.target_user_id=${job.userId} or r.reporter_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'moderation_action', id::text, 'moderation',
          jsonb_build_object('scope','moderation_vault','actionId',id::text)
        from moderation_actions where subject_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'moderation_quarantine', q.id::text, 'legal_hold',
          jsonb_build_object('scope','moderation_vault','quarantineId',q.id::text)
        from moderation_content_quarantines q join reports r on r.id=q.report_id
        where r.target_user_id=${job.userId} or r.reporter_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'moderation_media_copy', id::text, 'legal_hold',
          jsonb_build_object('scope','moderation_vault','mediaCopyId',id::text)
        from moderation_media_copies where subject_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'moderation_appeal', a.id::text, 'moderation',
          jsonb_build_object('scope','moderation_vault','appealId',a.id::text)
        from appeals a where a.appellant_user_id=${job.userId} or exists (
          select 1 from moderation_cases c join reports r on r.id=c.report_id
          where c.id in (a.original_case_id,a.review_case_id)
            and (r.target_user_id=${job.userId} or r.reporter_user_id=${job.userId}))
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'moderation_risk_signal', id::text, 'moderation',
          jsonb_build_object('scope','moderation_vault','riskSignalId',id::text)
        from risk_signals where subject_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'legal_workflow_task', t.id::text, 'legal_hold',
          jsonb_build_object('scope','legal_workflow','taskId',t.id::text)
        from legal_workflow_tasks t join moderation_cases c on c.id=t.case_id join reports r on r.id=c.report_id
        where r.target_user_id=${job.userId} or r.reporter_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'user_restriction', id::text, 'moderation',
          jsonb_build_object('scope','moderation_vault','restrictionId',id::text)
        from user_restrictions where subject_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
      await tx.execute(sql`insert into privacy_retention_ledger
        (deletion_request_id,user_id,record_type,record_id,legal_basis,restricted_locator)
        select ${job.id}, ${job.userId}, 'media_preservation_task', id::text, 'legal_hold',
          jsonb_build_object('scope','moderation_vault','taskId',id::text)
        from media_preservation_tasks where subject_user_id=${job.userId}
        on conflict (deletion_request_id,record_type,record_id) do nothing`);
    });
  }
  async anonymizeEligible(job: DeletionJob) {
    const now = this.clock();
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      await this.assertActiveLease(tx, job);
      await tx.execute(sql`update messages set body='[deleted]' where sender_user_id=${job.userId}
        and not exists (select 1 from moderation_evidence e
          join reports r on r.id=e.report_id
          where e.kind='message_reference'
            and e.locator->>'referenceType'='message'
            and e.locator->>'referenceId'=messages.id::text
            and r.target_type='message' and r.target_user_id=${job.userId}
            and r.message_id=messages.id and r.conversation_id=messages.conversation_id)`);
      await tx.execute(sql`delete from verifications where identifier in
        (select email from users where id=${job.userId} union select phone_number from users where id=${job.userId})`);
      await tx.execute(sql`delete from identity_session_intents where user_id=${job.userId}`);
      await tx.execute(sql`update verification_attempts set user_id=null, provider_reference=null,
        idempotency_key_hash=null, redirect_url_encrypted=null, redirect_encryption_key_id=null
        where user_id=${job.userId}`);
      await tx.delete(sessions).where(eq(sessions.userId, job.userId));
      await tx.delete(accounts).where(eq(accounts.userId, job.userId));
      await tx.delete(twoFactors).where(eq(twoFactors.userId, job.userId));
      await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, job.userId));
      await tx.delete(profilePreferences).where(eq(profilePreferences.userId, job.userId));
      await tx.delete(privacySettings).where(eq(privacySettings.userId, job.userId));
      await tx.execute(sql`delete from profile_interests using profiles
        where profile_interests.profile_id=profiles.id and profiles.user_id=${job.userId}`);
      await tx.update(profilePhotoUploads).set({ stagingCleanupDueAt: now, finalOrphanCleanupDueAt: now,
        updatedAt: now }).where(eq(profilePhotoUploads.userId, job.userId));
      await tx.execute(sql`update profile_photos set user_removed_at=${now}, cleanup_due_at=${now}, updated_at=${now}
        where user_id=${job.userId} and not exists (select 1 from moderation_media_holds h
          where h.photo_id=profile_photos.id and h.active=true)`);
      await tx.update(profiles).set({ displayName: null, birthDate: null, genderCode: null,
        relationshipGoalCode: null, countryCode: null, timeZone: null, city: null, bio: null,
        publishRequested: false, discoverable: false, status: "restricted", updatedAt: now })
        .where(eq(profiles.userId, job.userId));
      await tx.update(users).set({ name: "Deleted member", email: `deleted+${job.userId}@privacy.invalid`,
        phoneNumber: null, phoneNumberVerified: false, image: null, updatedAt: now }).where(eq(users.id, job.userId));
    });
  }
  async complete(job: DeletionJob) {
    const now = this.clock();
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      await this.assertActiveLease(tx, job);
      const rows = await tx.update(accountDeletionRequests).set({ status: "completed", completedAt: now,
        leaseId: null, leaseExpiresAt: null, updatedAt: now }).where(and(eq(accountDeletionRequests.id, job.id),
        eq(accountDeletionRequests.status, "processing"), eq(accountDeletionRequests.leaseId, job.leaseId)))
        .returning({ userId: accountDeletionRequests.userId });
      if (rows.length !== 1) throw new Error("DELETION_LEASE_LOST");
      await tx.insert(privacyWorkflowOutbox).values({ userId: rows[0]!.userId, deletionRequestId: job.id,
        eventType: "deletion_completed", dedupeKey: `deletion-completed:${job.id}`, availableAt: now, createdAt: now })
        .onConflictDoNothing();
      await tx.insert(privacyAuditEvents).values({ userId: rows[0]!.userId, deletionRequestId: job.id,
        eventType: "deletion_completed", occurredAt: now }).onConflictDoNothing();
    });
  }
  async retry(job: DeletionJob, input: { errorCode: "DELETION_FAILED"; availableAt: Date }) {
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      await this.assertActiveLease(tx, job);
      const rows = await tx.update(accountDeletionRequests).set({ status: "cooling_off", availableAt: input.availableAt,
        lastErrorCode: input.errorCode, leaseId: null, leaseExpiresAt: null, updatedAt: this.clock() })
        .where(and(eq(accountDeletionRequests.id, job.id), eq(accountDeletionRequests.status, "processing"),
          eq(accountDeletionRequests.leaseId, job.leaseId))).returning({ id: accountDeletionRequests.id });
      if (rows.length !== 1) throw new Error("DELETION_LEASE_LOST");
    });
  }
  async manualReview(job: DeletionJob, errorCode: "DELETION_FAILED") {
    const now = this.clock();
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      await this.assertActiveLease(tx, job);
      const rows = await tx.update(accountDeletionRequests).set({ status: "manual_review",
        lastErrorCode: errorCode, manualReviewAt: now, leaseId: null, leaseExpiresAt: null, updatedAt: now })
        .where(and(eq(accountDeletionRequests.id, job.id), eq(accountDeletionRequests.status, "processing"),
          eq(accountDeletionRequests.leaseId, job.leaseId))).returning({ id: accountDeletionRequests.id });
      if (rows.length !== 1) throw new Error("DELETION_LEASE_LOST");
    });
  }
}
