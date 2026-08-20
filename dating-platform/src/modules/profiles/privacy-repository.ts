import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

import { accountDeletionRequests, moderationMediaHolds, privacyAuditEvents,
  notificationPreferences, privacyExportJobs, privacyWorkflowOutbox, profiles, sessions, users } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import { enqueueProductionNotification } from "@/modules/notifications/notification-producer";

type PrivacyDatabase = typeof productionDatabase;

export class DrizzlePrivacyRepository {
  private readonly database: PrivacyDatabase;

  constructor(database: unknown, private readonly clock: () => Date = () => new Date(),
    private readonly enqueueSecureCancellation?: (transaction: unknown, input: {
      userId: string; recipient: string; locale: "en" | "zh-CN"; token: string; expiresAt: Date;
    }) => Promise<void>) {
    this.database = database as PrivacyDatabase;
  }

  async createOrGetExport(input: { userId: string; idempotencyKey: string; requestedAt: Date }) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      const inserted = await tx.insert(privacyExportJobs).values({ userId: input.userId,
        idempotencyKey: input.idempotencyKey, availableAt: input.requestedAt, createdAt: input.requestedAt,
        updatedAt: input.requestedAt }).onConflictDoNothing({ target: [privacyExportJobs.userId,
        privacyExportJobs.idempotencyKey] }).returning();
      const [row] = inserted.length ? inserted : await tx.select().from(privacyExportJobs)
        .where(and(eq(privacyExportJobs.userId, input.userId), eq(privacyExportJobs.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (!row) throw new Error("EXPORT_NOT_AVAILABLE");
      if (inserted.length) await tx.insert(privacyWorkflowOutbox).values({ userId: input.userId, exportJobId: row.id,
        eventType: "export_requested", dedupeKey: `export-requested:${row.id}`, availableAt: input.requestedAt,
        createdAt: input.requestedAt }).onConflictDoNothing();
      return { jobId: row.id, ownerId: row.userId, status: row.status as "pending" | "processing" | "ready" | "failed",
        replayed: inserted.length === 0 };
    });
  }

  createOrGet(input: { userId: string; idempotencyKey: string; requestedAt: Date }) {
    return this.createOrGetExport(input);
  }

  async beginDeletion(input: { userId: string; idempotencyKey: string; requestedAt?: Date; executeAt: Date;
    preserveHeldRecords: boolean }) {
    const cancellationToken = randomBytes(32).toString("base64url");
    const cancellationTokenHash = createHash("sha256").update(cancellationToken).digest("hex");
    try {
      return await this.database.transaction(async (transaction) => {
        const tx = transaction as unknown as PrivacyDatabase;
        const [owner] = await tx.select({ id: users.id, email: users.email }).from(users)
          .where(eq(users.id, input.userId))
          .limit(1).for("update");
        if (!owner) throw new Error("DELETION_CONFLICT");
        const [preference] = await tx.select({ locale: notificationPreferences.locale })
          .from(notificationPreferences).where(eq(notificationPreferences.userId, input.userId)).limit(1);
        const inserted = await tx.insert(accountDeletionRequests).values({ userId: input.userId,
          idempotencyKey: input.idempotencyKey, executeAt: input.executeAt, availableAt: input.executeAt,
          createdAt: input.requestedAt ?? new Date(input.executeAt.getTime() - 30 * 86_400_000),
          preserveHeldRecords: input.preserveHeldRecords, cancellationTokenHash,
          cancellationTokenExpiresAt: input.executeAt }).onConflictDoNothing({ target: [accountDeletionRequests.userId,
          accountDeletionRequests.idempotencyKey] }).returning();
        const [row] = inserted.length ? inserted : await tx.select().from(accountDeletionRequests)
          .where(and(eq(accountDeletionRequests.userId, input.userId),
            eq(accountDeletionRequests.idempotencyKey, input.idempotencyKey))).limit(1);
        if (!row || !["cooling_off", "processing", "completed"].includes(row.status)) throw new Error("DELETION_CONFLICT");
        if (inserted.length) {
          if (!this.enqueueSecureCancellation) throw new Error("DELETION_CANCELLATION_DELIVERY_UNAVAILABLE");
          await this.enqueueSecureCancellation(tx, { userId: input.userId, recipient: owner.email,
            locale: preference?.locale === "zh-CN" ? "zh-CN" : "en", token: cancellationToken,
            expiresAt: row.cancellationTokenExpiresAt });
        }
        return { requestId: row.id, executeAt: row.executeAt, preserveHeldRecords: row.preserveHeldRecords,
          cancellationToken: inserted.length ? cancellationToken : null, replayed: inserted.length === 0 };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "DELETION_CONFLICT") throw error;
      const [active] = await this.database.select({ id: accountDeletionRequests.id }).from(accountDeletionRequests)
        .where(and(eq(accountDeletionRequests.userId, input.userId),
          inArray(accountDeletionRequests.status, ["cooling_off", "processing"]))).limit(1);
      if (active) throw new Error("DELETION_CONFLICT");
      throw error;
    }
  }

  begin(input: { userId: string; idempotencyKey: string; requestedAt?: Date; executeAt: Date;
    preserveHeldRecords: boolean }) {
    return this.beginDeletion(input);
  }

  async authenticateCancellationCredential(input: { token: string; now: Date }) {
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const [request] = await this.database.select({ userId: accountDeletionRequests.userId })
      .from(accountDeletionRequests).where(and(eq(accountDeletionRequests.cancellationTokenHash, tokenHash),
        eq(accountDeletionRequests.status, "cooling_off"), gt(accountDeletionRequests.executeAt, input.now),
        gt(accountDeletionRequests.cancellationTokenExpiresAt, input.now),
        sql`${accountDeletionRequests.cancellationTokenUsedAt} IS NULL`,
        sql`${accountDeletionRequests.cancellationTokenRevokedAt} IS NULL`)).limit(1);
    return request ?? null;
  }

  async cancelDeletion(input: { token: string; idempotencyKey: string }) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      const now = this.clock();
      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      const [request] = await tx.select({ id: accountDeletionRequests.id, status: accountDeletionRequests.status,
        userId: accountDeletionRequests.userId, executeAt: accountDeletionRequests.executeAt,
        originalProfileDiscoverable: accountDeletionRequests.originalProfileDiscoverable }).from(accountDeletionRequests)
        .where(and(eq(accountDeletionRequests.cancellationTokenHash, tokenHash),
          sql`${accountDeletionRequests.cancellationTokenUsedAt} IS NULL`,
          sql`${accountDeletionRequests.cancellationTokenRevokedAt} IS NULL`,
          gt(accountDeletionRequests.cancellationTokenExpiresAt, now))).limit(1).for("update");
      if (!request) throw new Error("DELETION_NOT_CANCELABLE");
      const replayToken = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);
      const dedupeKey = `deletion-canceled:${request.id}:${replayToken}`;
      if (request.status !== "cooling_off" || request.executeAt <= now) throw new Error("DELETION_NOT_CANCELABLE");
      const rows = await tx.update(accountDeletionRequests).set({ status: "canceled", canceledAt: now, updatedAt: now,
        cancellationTokenUsedAt: now, leaseId: null, leaseExpiresAt: null }).where(and(eq(accountDeletionRequests.id, request.id),
        eq(accountDeletionRequests.status, "cooling_off"), gt(accountDeletionRequests.executeAt, now)))
        .returning({ id: accountDeletionRequests.id });
      if (rows.length !== 1) throw new Error("DELETION_NOT_CANCELABLE");
      await tx.update(profiles).set({ discoverable: request.originalProfileDiscoverable, updatedAt: now })
        .where(eq(profiles.userId, request.userId));
      await tx.insert(privacyWorkflowOutbox).values({ userId: request.userId, deletionRequestId: rows[0]!.id,
        eventType: "deletion_canceled", dedupeKey, availableAt: now, createdAt: now })
        .onConflictDoNothing();
      await tx.insert(privacyAuditEvents).values({ userId: request.userId, deletionRequestId: rows[0]!.id,
        eventType: "deletion_canceled", details: { idempotencyKeyHash: replayToken }, occurredAt: now })
        .onConflictDoNothing();
      return { idempotencyKey: input.idempotencyKey, canceled: true };
    });
  }

  cancel(input: { token: string; idempotencyKey: string }) { return this.cancelDeletion(input); }

  async hasLegalHold(userId: string) {
    const [row] = await this.database.select({ id: moderationMediaHolds.id }).from(moderationMediaHolds)
      .where(and(eq(moderationMediaHolds.subjectUserId, userId), eq(moderationMediaHolds.active, true),
        or(sql`${moderationMediaHolds.preserveUntil} IS NULL`, gt(moderationMediaHolds.preserveUntil, this.clock())))).limit(1);
    return Boolean(row);
  }

  async revokeSessions(userId: string) { await this.database.delete(sessions).where(eq(sessions.userId, userId)); }
  async hideProfile(userId: string) {
    await this.database.update(profiles).set({ discoverable: false, updatedAt: this.clock() }).where(eq(profiles.userId, userId));
  }

  async enqueueRenewalCancellation(input: { userId: string; requestId: string }) {
    await this.database.insert(privacyWorkflowOutbox).values({ userId: input.userId, deletionRequestId: input.requestId,
      eventType: "renewal_cancel_requested", dedupeKey: `renewal-cancel:${input.requestId}`, availableAt: this.clock() })
      .onConflictDoNothing();
  }

  async enqueueNotification(input: { userId: string; requestId?: string; jobId?: string; templateKey: string;
    payload?: Record<string, string> }) {
    await enqueueProductionNotification(this.database, { userId: input.userId,
      dedupeKey: `privacy:${input.requestId ?? input.jobId}:${input.templateKey}`, category: "security",
      templateKey: input.templateKey, payload: input.payload, availableAt: this.clock() });
  }

  async claimDownload(input: { userId: string; jobId: string; token: string; now: Date }) {
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as PrivacyDatabase;
      const [row] = await tx.select().from(privacyExportJobs).where(and(eq(privacyExportJobs.id, input.jobId),
          eq(privacyExportJobs.userId, input.userId), eq(privacyExportJobs.status, "ready"),
          eq(privacyExportJobs.downloadTokenHash, tokenHash), gt(privacyExportJobs.expiresAt, input.now),
          gt(privacyExportJobs.downloadTokenExpiresAt, input.now), sql`${privacyExportJobs.downloadTokenUsedAt} IS NULL`,
          sql`${privacyExportJobs.downloadTokenRevokedAt} IS NULL`,
          sql`(${privacyExportJobs.downloadLeaseId} IS NULL OR ${privacyExportJobs.downloadLeaseExpiresAt} <= statement_timestamp())`))
        .orderBy(desc(privacyExportJobs.completedAt)).limit(1).for("update");
      if (!row?.objectKey || !row.objectVersion || !row.integritySha256 || !row.encryptionKeyId
        || !row.downloadTokenExpiresAt) return null;
      const leaseId = randomUUID();
      const [claimed] = await tx.update(privacyExportJobs).set({ downloadLeaseId: leaseId,
        downloadLeaseExpiresAt: sql`statement_timestamp() + interval '2 minutes'`, updatedAt: this.clock() })
        .where(and(eq(privacyExportJobs.id, row.id), sql`${privacyExportJobs.downloadTokenUsedAt} IS NULL`,
          sql`(${privacyExportJobs.downloadLeaseId} IS NULL OR ${privacyExportJobs.downloadLeaseExpiresAt} <= statement_timestamp())`))
        .returning({ leaseExpiresAt: privacyExportJobs.downloadLeaseExpiresAt });
      if (!claimed) return null;
      return { jobId: row.id, leaseId, ownerId: row.userId, tokenHash, objectKey: row.objectKey,
        objectVersion: row.objectVersion, integritySha256: row.integritySha256,
        encryptionKeyId: row.encryptionKeyId, expiresAt: row.downloadTokenExpiresAt };
    });
  }

  async completeDownload(claim: { jobId: string; leaseId: string; ownerId: string; tokenHash: string }) {
    const rows = await this.database.update(privacyExportJobs).set({ downloadTokenUsedAt: sql`statement_timestamp()`,
      downloadLeaseId: null, downloadLeaseExpiresAt: null, updatedAt: this.clock() })
      .where(and(eq(privacyExportJobs.id, claim.jobId), eq(privacyExportJobs.userId, claim.ownerId),
        eq(privacyExportJobs.status, "ready"), eq(privacyExportJobs.downloadTokenHash, claim.tokenHash),
        eq(privacyExportJobs.downloadLeaseId, claim.leaseId),
        sql`${privacyExportJobs.downloadLeaseExpiresAt} > statement_timestamp()`,
        sql`${privacyExportJobs.downloadTokenUsedAt} IS NULL`, sql`${privacyExportJobs.downloadTokenRevokedAt} IS NULL`))
      .returning({ id: privacyExportJobs.id });
    return rows.length === 1;
  }

  async releaseDownload(claim: { jobId: string; leaseId: string; ownerId: string; tokenHash: string }) {
    const rows = await this.database.update(privacyExportJobs).set({ downloadLeaseId: null,
      downloadLeaseExpiresAt: null, updatedAt: this.clock() })
      .where(and(eq(privacyExportJobs.id, claim.jobId), eq(privacyExportJobs.userId, claim.ownerId),
        eq(privacyExportJobs.downloadTokenHash, claim.tokenHash), eq(privacyExportJobs.downloadLeaseId, claim.leaseId),
        sql`${privacyExportJobs.downloadTokenUsedAt} IS NULL`)).returning({ id: privacyExportJobs.id });
    return rows.length === 1;
  }
}
