import { createHmac, timingSafeEqual } from "node:crypto";

import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import {
  adminActionIdempotency,
  adminApprovalDecisions,
  adminApprovalRequests,
  adminAuditLogs,
  adminConfigChanges,
  adminOutboxEvents,
  adminRoleAssignments,
  adminSessions,
  adminUserActionVersions,
  appeals,
  billingPayments,
  billingReconciliationItems,
  entitlementConfigurations,
  mediaReviewJobs,
  moderationCases,
  verificationAttempts,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import { parseEntitlementGrant } from "@/modules/entitlements/entitlement-service";
import { ENTITLEMENT_CATALOG, PUBLIC_ENTITLEMENT_KEYS } from "@/modules/entitlements/types";
import type { DrizzleCaseService } from "@/modules/moderation/case-service";

import { buildAuditRecord, redactAuditDiff, sanitizeAuditReason } from "./audit-service";
import { refundApprovalPayloadSchema } from "./approval-contract";
import type {
  AdminQueue,
  AdminQueueRepository,
  ApprovalRepository,
  ApprovalRequest,
  GovernanceProjection,
  VersionedEntitlementConfiguration,
} from "./admin-service";
import { ADMIN_ROLES, type AdminRole } from "./permissions";

type AdminDatabase = typeof productionDatabase;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

export class DrizzleAdminSessionReader {
  constructor(private readonly database: AdminDatabase, private readonly hmacKey: string,
    private readonly clock: () => Date = () => new Date()) {}

  async read(headers: Headers) {
    const cookie = headers.get("cookie") ?? "";
    if (cookie.length > 8_192) return null;
    const raw = cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("dating_platform_admin="))
      ?.slice("dating_platform_admin=".length);
    if (!raw || !/^[A-Za-z0-9_-]{32,256}$/u.test(raw)) return null;
    const tokenHash = createHmac("sha256", this.hmacKey).update(raw).digest("hex");
    const now = this.clock();
    const [row] = await this.database.select({
      adminSessionId: adminSessions.id,
      userId: adminSessions.userId,
      assignmentUserId: adminRoleAssignments.userId,
      role: adminRoleAssignments.role,
      mfaVerifiedAt: adminSessions.mfaVerifiedAt,
    }).from(adminSessions).innerJoin(adminRoleAssignments,
      eq(adminRoleAssignments.id, adminSessions.roleAssignmentId)).where(and(
      eq(adminSessions.tokenHash, tokenHash),
      isNull(adminSessions.revokedAt),
      gt(adminSessions.expiresAt, now),
      eq(adminRoleAssignments.active, "active"),
    )).limit(1);
    if (!row || row.userId !== row.assignmentUserId || !(ADMIN_ROLES as readonly string[]).includes(row.role)) return null;
    return { adminSessionId: row.adminSessionId, userId: row.userId, role: row.role as AdminRole,
      mfaVerifiedAt: row.mfaVerifiedAt };
  }
}

type RedisLike = {
  isOpen?: boolean;
  connect(): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

export class RedisAdminRateLimiter {
  constructor(private readonly client: RedisLike, private readonly hmacKey: string,
    private readonly limit = 20, private readonly windowMs = 60_000) {}

  async consume(input: { userId: string; key: "admin.user_action" | "admin.entitlement_config" | "admin.approval" }) {
    if (!this.client.isOpen) await this.client.connect();
    const actor = createHmac("sha256", this.hmacKey).update(input.userId).digest("base64url");
    const result = await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}",
      { keys: [`admin:rate:${input.key}:${actor}`], arguments: [String(this.windowMs)] },
    );
    if (!Array.isArray(result) || result.length !== 2) throw new Error("ADMIN_RATE_LIMIT_UNAVAILABLE");
    const current = Number(result[0]);
    const ttl = Number(result[1]);
    if (!Number.isSafeInteger(current) || current < 1 || !Number.isFinite(ttl)) throw new Error("ADMIN_RATE_LIMIT_UNAVAILABLE");
    return current <= this.limit ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1_000)) };
  }
}

export class DrizzleApprovalRepository implements ApprovalRepository {
  constructor(private readonly database: AdminDatabase, private readonly auditHmacKey: string) {}

  async create(request: Omit<ApprovalRequest, "ipHash">, context: { requestId: string; ipAddress: string }) {
    const audit = buildAuditRecord({
      actorUserId: request.requesterUserId, permission: request.requestPermission,
      targetType: request.targetType, targetId: request.targetId,
      before: {}, after: { status: "pending", action: request.action, payloadHash: request.payloadHash },
      reason: request.reason, requestId: context.requestId, ipAddress: context.ipAddress,
      ipHmacKey: this.auditHmacKey, createdAt: request.createdAt,
    });
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const [created] = await tx.insert(adminApprovalRequests).values({ ...request, ipHash: audit.ipHash }).returning();
      await tx.insert(adminAuditLogs).values(audit);
      await tx.insert(adminOutboxEvents).values({ approvalRequestId: created!.id,
        eventType: `admin.${request.action}.requested`, aggregateType: request.targetType,
        aggregateId: request.targetId, requestId: context.requestId, ipHash: audit.ipHash,
        status: "pending", createdAt: request.createdAt,
        payload: { approvalRequestId: created!.id, action: request.action, targetType: request.targetType,
          targetId: request.targetId, payloadHash: request.payloadHash,
          requestId: context.requestId, ipHash: audit.ipHash, transition: { status: "pending" } },
      });
      return { ...request, ipHash: audit.ipHash, id: created!.id };
    });
  }

  async list(input: { actorUserId: string; allowedApprovalPermissions: readonly ApprovalRequest["approvalPermission"][];
    limit: number; cursor?: string }) {
    const cursor = this.decodeCursor(input.cursor);
    const visible = input.allowedApprovalPermissions.length
      ? inArray(adminApprovalRequests.approvalPermission, [...input.allowedApprovalPermissions])
      : sql<boolean>`false`;
    const rows = await this.database.select({
      id: adminApprovalRequests.id, action: adminApprovalRequests.action,
      targetType: adminApprovalRequests.targetType, targetId: adminApprovalRequests.targetId,
      status: adminApprovalRequests.status, payloadHash: adminApprovalRequests.payloadHash,
      expiresAt: adminApprovalRequests.expiresAt, createdAt: adminApprovalRequests.createdAt,
    }).from(adminApprovalRequests).where(and(
      visible,
      cursor ? or(lt(adminApprovalRequests.createdAt, new Date(cursor.createdAt)), and(
        eq(adminApprovalRequests.createdAt, new Date(cursor.createdAt)), lt(adminApprovalRequests.id, cursor.id),
      )) : undefined,
    ))
      .orderBy(desc(adminApprovalRequests.createdAt), desc(adminApprovalRequests.id)).limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { items: page, nextCursor: rows.length > input.limit ? this.encodeCursor(page.at(-1)!) : null };
  }

  async get(input: { actorUserId: string; allowedApprovalPermissions: readonly ApprovalRequest["approvalPermission"][];
    id: string }) {
    const [row] = await this.database.select({
      id: adminApprovalRequests.id, requesterUserId: adminApprovalRequests.requesterUserId,
      action: adminApprovalRequests.action, requestPermission: adminApprovalRequests.requestPermission,
      approvalPermission: adminApprovalRequests.approvalPermission, targetType: adminApprovalRequests.targetType,
      targetId: adminApprovalRequests.targetId, payloadVersion: adminApprovalRequests.payloadVersion,
      payload: adminApprovalRequests.payload, payloadHash: adminApprovalRequests.payloadHash, reason: adminApprovalRequests.reason,
      status: adminApprovalRequests.status, expiresAt: adminApprovalRequests.expiresAt,
      createdAt: adminApprovalRequests.createdAt,
    }).from(adminApprovalRequests).where(and(eq(adminApprovalRequests.id, input.id),
      input.allowedApprovalPermissions.length
        ? inArray(adminApprovalRequests.approvalPermission, [...input.allowedApprovalPermissions])
        : sql<boolean>`false`)).limit(1);
    if (!row) return null;
    if (row.action !== "manual_refund") return row;
    const payload = refundApprovalPayloadSchema.safeParse(row.payload);
    if (!payload.success) return null;
    const [payment] = await this.database.select({ currency: billingPayments.currency }).from(billingPayments)
      .where(eq(billingPayments.id, payload.data.paymentId)).limit(1);
    return { ...row, currency: payment?.currency ?? null };
  }

  async decide(input: {
    approvalId: string; approverUserId: string; approverAdminSessionId: string;
    decision: "approved" | "rejected"; reason: string; now: Date;
    context: { requestId: string; ipAddress: string };
  }) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const [request] = await tx.select().from(adminApprovalRequests)
        .where(eq(adminApprovalRequests.id, input.approvalId)).for("update").limit(1);
      if (!request || request.status !== "pending" || request.expiresAt <= input.now) {
        throw new Error("ACTION_NOT_AVAILABLE");
      }
      if (request.requesterUserId === input.approverUserId) throw new Error("FORBIDDEN");
      await tx.insert(adminApprovalDecisions).values({
        requestId: request.id, approverUserId: input.approverUserId,
        approverAdminSessionId: input.approverAdminSessionId,
        permission: request.approvalPermission, decision: input.decision, reason: input.reason, createdAt: input.now,
      });
      const audit = buildAuditRecord({
        actorUserId: input.approverUserId, permission: request.approvalPermission,
        targetType: request.targetType, targetId: request.targetId,
        before: { status: "pending" }, after: { status: input.decision, payloadHash: request.payloadHash },
        reason: input.reason, requestId: input.context.requestId, ipAddress: input.context.ipAddress,
        ipHmacKey: this.auditHmacKey, createdAt: input.now,
      });
      await tx.insert(adminAuditLogs).values(audit);
      await tx.insert(adminOutboxEvents).values({ approvalRequestId: request.id,
        eventType: `admin.${request.action}.${input.decision}`, aggregateType: request.targetType,
        aggregateId: request.targetId, requestId: input.context.requestId, ipHash: audit.ipHash,
        status: "pending", createdAt: input.now,
        payload: { approvalRequestId: request.id, action: request.action, targetType: request.targetType,
          targetId: request.targetId, payloadHash: request.payloadHash,
          requestId: input.context.requestId, ipHash: audit.ipHash, transition: { status: input.decision } },
      });
      return { status: input.decision, replayed: false };
    });
  }

  private encodeCursor(row: { id: string; createdAt: Date }) {
    const body = Buffer.from(JSON.stringify({ id: row.id, createdAt: row.createdAt.toISOString() }), "utf8").toString("base64url");
    return `${body}.${createHmac("sha256", this.auditHmacKey).update(body).digest("base64url")}`;
  }

  private decodeCursor(value?: string): { id: string; createdAt: string } | null {
    if (!value) return null;
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra || value.length > 1200) throw new Error("INVALID_CURSOR");
    const expected = createHmac("sha256", this.auditHmacKey).update(body).digest("base64url");
    const left = Buffer.from(signature); const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("INVALID_CURSOR");
    try {
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
      if (Object.keys(parsed).sort().join(",") !== "createdAt,id" || typeof parsed.id !== "string"
        || !/^[0-9a-f-]{36}$/iu.test(parsed.id) || typeof parsed.createdAt !== "string"
        || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
      return parsed as { id: string; createdAt: string };
    } catch { throw new Error("INVALID_CURSOR"); }
  }

}

export class DrizzleVersionedEntitlementConfiguration implements VersionedEntitlementConfiguration {
  constructor(private readonly database: AdminDatabase, private readonly hmacKey: string) {}

  async appendVersion(input: Parameters<VersionedEntitlementConfiguration["appendVersion"]>[0]) {
    if (!(PUBLIC_ENTITLEMENT_KEYS as readonly string[]).includes(input.entitlementKey)) throw new Error("INVALID_CONFIGURATION");
    const definition = ENTITLEMENT_CATALOG[input.entitlementKey as keyof typeof ENTITLEMENT_CATALOG];
    if (input.grant.kind !== definition.kind) throw new Error("INVALID_CONFIGURATION");
    if (input.scope === "global_flag") {
      if (input.grant.booleanValue !== null || input.grant.quotaLimit !== null
        || input.grant.numericValue !== null || input.grant.upgradeHint !== null) throw new Error("INVALID_CONFIGURATION");
    } else parseEntitlementGrant(input.grant, definition.kind, definition.resetPeriod);
    const payloadHash = createHmac("sha256", this.hmacKey).update(canonical(input)).digest("hex");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const [replay] = await tx.select().from(adminActionIdempotency).where(and(
        eq(adminActionIdempotency.actorUserId, input.actorUserId),
        eq(adminActionIdempotency.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replay) {
        if (replay.payloadHash !== payloadHash || replay.action !== "entitlement_config") throw new Error("IDEMPOTENCY_CONFLICT");
        return { ...(replay.result as { version: number }), replayed: true };
      }
      const [current] = await tx.select({ version: entitlementConfigurations.version })
        .from(entitlementConfigurations).where(and(
          eq(entitlementConfigurations.entitlementKey, input.entitlementKey),
          eq(entitlementConfigurations.scope, input.scope),
        )).orderBy(desc(entitlementConfigurations.version)).for("update").limit(1);
      const version = current?.version ?? 0;
      if (version !== input.expectedVersion || input.nextVersion !== version + 1) throw new Error("VERSION_CONFLICT");
      await tx.insert(entitlementConfigurations).values({
        entitlementKey: input.entitlementKey,
        scope: input.scope,
        version: input.nextVersion,
        kind: input.grant.kind,
        enabled: input.grant.enabled,
        booleanValue: input.grant.booleanValue,
        quotaLimit: input.grant.quotaLimit,
        numericValue: input.grant.numericValue,
        upgradeHint: input.grant.upgradeHint,
        active: true,
        effectiveAt: input.effectiveAt,
        expiresAt: null,
      });
      await tx.insert(adminConfigChanges).values({
        actorUserId: input.actorUserId, configType: "entitlement", targetId: `${input.entitlementKey}:${input.scope}`,
        previousVersion: version, newVersion: input.nextVersion, payloadHash, idempotencyKey: input.idempotencyKey,
        reason: input.reason, createdAt: input.effectiveAt,
      });
      const result = { version: input.nextVersion };
      await tx.insert(adminActionIdempotency).values({
        actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey, action: "entitlement_config",
        targetType: "entitlement", targetId: `${input.entitlementKey}:${input.scope}`, payloadHash,
        expectedVersion: input.expectedVersion, result, createdAt: input.effectiveAt,
      });
      await tx.insert(adminAuditLogs).values(buildAuditRecord({ actorUserId: input.actorUserId,
        permission: "entitlements.config.write", targetType: "entitlement",
        targetId: `${input.entitlementKey}:${input.scope}`, before: { version },
        after: { version: input.nextVersion, grant: input.grant }, reason: input.reason,
        requestId: input.context.requestId, ipAddress: input.context.ipAddress,
        ipHmacKey: this.hmacKey, createdAt: input.effectiveAt,
      }));
      return { ...result, replayed: false };
    });
  }
}

export class DrizzleAdminGovernanceProjection implements GovernanceProjection {
  constructor(private readonly database: AdminDatabase, private readonly caseService: DrizzleCaseService,
    private readonly hmacKey: string, private readonly clock: () => Date = () => new Date()) {}

  async applyUserAction(input: Parameters<GovernanceProjection["applyUserAction"]>[0]) {
    const boundAction = { actorUserId: input.actorUserId, actorRole: input.actorRole, targetUserId: input.targetUserId,
      action: input.action, caseId: input.caseId, reason: input.reason,
      idempotencyKey: input.idempotencyKey, expectedVersion: input.expectedVersion,
      ...(input.durationHours === undefined ? {} : { durationHours: input.durationHours }) };
    const payloadHash = createHmac("sha256", this.hmacKey).update(canonical(boundAction)).digest("hex");
    const now = this.clock();
    const expiryPolicy = input.action === "ban" ? "indefinite_review" as const : "fixed" as const;
    const expiresAt = input.action === "ban" ? new Date("9999-12-31T23:59:59.000Z")
      : new Date(now.getTime() + (input.durationHours ?? 1) * 60 * 60_000);
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const findReplay = async () => {
        const [replay] = await tx.select().from(adminActionIdempotency).where(and(
          eq(adminActionIdempotency.actorUserId, input.actorUserId),
          eq(adminActionIdempotency.idempotencyKey, input.idempotencyKey),
        )).limit(1);
        if (replay && (replay.payloadHash !== payloadHash || replay.action !== input.action)) {
          throw new Error("IDEMPOTENCY_CONFLICT");
        }
        return replay;
      };
      const replay = await findReplay();
      if (replay) return { ...(replay.result as Record<string, unknown>), replayed: true };
      await tx.insert(adminUserActionVersions).values({ targetUserId: input.targetUserId, version: 0, updatedAt: now })
        .onConflictDoNothing({ target: adminUserActionVersions.targetUserId });
      const [claimed] = await tx.update(adminUserActionVersions).set({
        version: input.expectedVersion + 1, updatedAt: now,
      }).where(and(eq(adminUserActionVersions.targetUserId, input.targetUserId),
        eq(adminUserActionVersions.version, input.expectedVersion))).returning({ version: adminUserActionVersions.version });
      if (!claimed) {
        const concurrentReplay = await findReplay();
        if (concurrentReplay) return { ...(concurrentReplay.result as Record<string, unknown>), replayed: true };
        throw new Error("VERSION_CONFLICT");
      }
      const moderationRole = input.actorRole === "safety" || input.actorRole === "super_admin"
        ? "safety_specialist" as const : "case_worker" as const;
      const action = await this.caseService.recordActionInTransaction(tx, input.caseId,
        { userId: input.actorUserId, role: moderationRole }, {
          subjectUserId: input.targetUserId,
          actionType: input.action,
          reasonCode: input.reason,
          evidenceSummary: input.reason,
          expiryPolicy,
          expiresAt,
        });
      const result = { actionId: action.id, status: action.actionType, version: claimed.version };
      await tx.insert(adminActionIdempotency).values({
        actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey, action: input.action,
        targetType: "user", targetId: input.targetUserId, payloadHash, expectedVersion: input.expectedVersion,
        result, createdAt: now,
      });
      const auditInput = { actorUserId: input.actorUserId, permission: "users.status.write",
        targetType: "user", targetId: input.targetUserId, before: { version: input.expectedVersion },
        after: { version: claimed.version, status: action.actionType }, reason: input.reason,
        requestId: input.context.requestId, createdAt: now };
      await tx.insert(adminAuditLogs).values("ipHash" in input.context ? {
        ...auditInput, beforeDiff: redactAuditDiff(auditInput.before), afterDiff: redactAuditDiff(auditInput.after),
        reason: sanitizeAuditReason(auditInput.reason), ipHash: input.context.ipHash,
      } : buildAuditRecord({ ...auditInput, ipAddress: input.context.ipAddress, ipHmacKey: this.hmacKey }));
      return { ...result, replayed: false };
    });
  }
}

type Cursor = { createdAt: string; id: string };

export class DrizzleAdminQueueRepository implements AdminQueueRepository {
  constructor(private readonly database: AdminDatabase, private readonly cursorSecret: string) {}

  async listQueue(input: { queue: AdminQueue; limit: number; cursor?: string }) {
    const cursor = this.decode(input.cursor);
    const whereAfter = <TDate, TId>(date: TDate, id: TId) => cursor ? or(
      lt(date as never, new Date(cursor.createdAt)),
      and(eq(date as never, new Date(cursor.createdAt)), lt(id as never, cursor.id)),
    ) : undefined;
    let rows: Array<{ id: string; status: string; createdAt: Date }>;
    if (input.queue === "profile_media") rows = await this.database.select({ id: mediaReviewJobs.id,
      status: mediaReviewJobs.status, createdAt: mediaReviewJobs.createdAt }).from(mediaReviewJobs)
      .where(and(or(eq(mediaReviewJobs.status, "pending"), eq(mediaReviewJobs.status, "processing"),
        eq(mediaReviewJobs.status, "failed")), whereAfter(mediaReviewJobs.createdAt, mediaReviewJobs.id)))
      .orderBy(desc(mediaReviewJobs.createdAt), desc(mediaReviewJobs.id)).limit(input.limit + 1);
    else if (input.queue === "reports") rows = await this.database.select({ id: moderationCases.id,
      status: moderationCases.status, createdAt: moderationCases.createdAt }).from(moderationCases)
      .where(and(eq(moderationCases.kind, "initial"), whereAfter(moderationCases.createdAt, moderationCases.id)))
      .orderBy(desc(moderationCases.createdAt), desc(moderationCases.id)).limit(input.limit + 1);
    else if (input.queue === "appeals") rows = await this.database.select({ id: appeals.id,
      status: appeals.status, createdAt: appeals.createdAt }).from(appeals)
      .where(whereAfter(appeals.createdAt, appeals.id))
      .orderBy(desc(appeals.createdAt), desc(appeals.id)).limit(input.limit + 1);
    else if (input.queue === "billing_discrepancies") rows = await this.database.select({ id: billingReconciliationItems.id,
      status: billingReconciliationItems.status, createdAt: billingReconciliationItems.createdAt })
      .from(billingReconciliationItems).where(and(or(eq(billingReconciliationItems.status, "open"),
        eq(billingReconciliationItems.status, "reviewing")), whereAfter(billingReconciliationItems.createdAt,
        billingReconciliationItems.id))).orderBy(desc(billingReconciliationItems.createdAt),
        desc(billingReconciliationItems.id)).limit(input.limit + 1);
    else if (input.queue === "verification_failures") rows = await this.database.select({ id: verificationAttempts.id,
      status: verificationAttempts.status, createdAt: verificationAttempts.createdAt }).from(verificationAttempts)
      .where(and(or(eq(verificationAttempts.status, "rejected"), eq(verificationAttempts.status, "expired")),
        whereAfter(verificationAttempts.createdAt, verificationAttempts.id)))
      .orderBy(desc(verificationAttempts.createdAt), desc(verificationAttempts.id)).limit(input.limit + 1);
    else rows = await this.database.select({ id: adminConfigChanges.id,
      status: sql<string>`'recorded'`, createdAt: adminConfigChanges.createdAt }).from(adminConfigChanges)
      .where(whereAfter(adminConfigChanges.createdAt, adminConfigChanges.id))
      .orderBy(desc(adminConfigChanges.createdAt), desc(adminConfigChanges.id)).limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      nextCursor: rows.length > input.limit && page.length ? this.encode(page.at(-1)!) : null };
  }

  private encode(cursor: { createdAt: Date; id: string }) {
    const body = Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.cursorSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private decode(value?: string): Cursor | null {
    if (!value) return null;
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra || value.length > 1200) throw new Error("INVALID_CURSOR");
    const expected = createHmac("sha256", this.cursorSecret).update(body).digest("base64url");
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("INVALID_CURSOR");
    try {
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
      if (Object.keys(parsed).sort().join(",") !== "createdAt,id" || Number.isNaN(Date.parse(parsed.createdAt))
        || !/^[0-9a-f-]{36}$/iu.test(parsed.id)) throw new Error();
      return parsed;
    } catch { throw new Error("INVALID_CURSOR"); }
  }
}
