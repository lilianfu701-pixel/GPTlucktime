import { createHash } from "node:crypto";

import {
  hasPermission,
  requirePermission,
  requireRecentMfa,
  ADMIN_ROLE_PERMISSIONS,
  type AdminPermission,
  type AdminRole,
} from "./permissions";
import { sanitizeAuditReason } from "./audit-service";
import {
  approvalRequestSchema,
  approvalSafePreview,
  canonicalAdminJson,
  normalizeAndDeriveApproval,
  type ApprovalRequestInput,
} from "./approval-contract";

export type SensitiveAdminAction =
  | "bulk_suspension"
  | "sensitive_export"
  | "manual_refund"
  | "payment_configuration"
  | "safety_evidence_access";

const sensitivePermissions: Record<SensitiveAdminAction, {
  request: AdminPermission;
  approve: AdminPermission;
}> = {
  bulk_suspension: { request: "users.bulk_suspend.request", approve: "users.bulk_suspend.approve" },
  sensitive_export: { request: "exports.sensitive.request", approve: "exports.sensitive.approve" },
  manual_refund: { request: "billing.refund.request", approve: "billing.refund.approve" },
  payment_configuration: { request: "billing.config.write", approve: "billing.config.approve" },
  safety_evidence_access: { request: "safety.evidence.request", approve: "safety.evidence.approve" },
};

export type AdminActor = {
  userId: string;
  adminSessionId?: string;
  role: AdminRole;
  mfaVerifiedAt: Date | null;
};

export type AdminRequestContext = { requestId: string; ipAddress: string };
export type StoredAdminRequestContext = { requestId: string; ipHash: string };

export type ApprovalRequest = {
  id?: string;
  requesterUserId: string;
  requesterAdminSessionId: string;
  requestId: string;
  ipHash: string;
  action: SensitiveAdminAction;
  requestPermission: AdminPermission;
  approvalPermission: AdminPermission;
  targetType: string;
  targetId: string;
  payloadVersion: number;
  payload: unknown;
  payloadHash: string;
  reason: string;
  status: "pending";
  expiresAt: Date;
  createdAt: Date;
};

export interface ApprovalRepository {
  create(request: Omit<ApprovalRequest, "ipHash">, context: AdminRequestContext): Promise<ApprovalRequest>;
  list?(input: { actorUserId: string; allowedApprovalPermissions: readonly AdminPermission[];
    limit: number; cursor?: string }): Promise<{
    items: Array<Record<string, unknown>>; nextCursor: string | null;
  }>;
  get?(input: { actorUserId: string; allowedApprovalPermissions: readonly AdminPermission[];
    id: string }): Promise<Record<string, unknown> | null>;
  decide?(input: {
    approvalId: string; approverUserId: string; approverAdminSessionId: string;
    decision: "approved" | "rejected"; reason: string; now: Date; context: AdminRequestContext;
  }): Promise<{ status: "approved" | "rejected" | "executing" | "executed"; replayed: boolean }>;
}

export interface GovernanceProjection {
  applyUserAction(input: {
    actorUserId: string;
    actorRole: AdminRole;
    targetUserId: string;
    action: "warn" | "temporary_restriction" | "suspend" | "ban" | "restore";
    caseId: string;
    reason: string;
    idempotencyKey: string;
    expectedVersion: number;
    durationHours?: number;
    context: AdminRequestContext | StoredAdminRequestContext;
  }): Promise<unknown>;
}

export interface VersionedEntitlementConfiguration {
  appendVersion(input: {
    entitlementKey: string;
    scope: "global_flag" | "free_default";
    expectedVersion: number;
    nextVersion: number;
    idempotencyKey: string;
    reason: string;
    grant: {
      kind: "boolean" | "quota" | "numeric";
      enabled: boolean;
      booleanValue: boolean | null;
      quotaLimit: number | null;
      numericValue: number | null;
      upgradeHint: string | null;
    };
    actorUserId: string;
    effectiveAt: Date;
    context: AdminRequestContext;
  }): Promise<unknown>;
}

export const ADMIN_QUEUE_PERMISSIONS = {
  profile_media: "profile_media.read",
  reports: "reports.read",
  appeals: "appeals.read",
  billing_discrepancies: "billing.discrepancies.read",
  verification_failures: "verification.failures.read",
  configuration_changes: "configuration.changes.read",
} as const satisfies Readonly<Record<string, AdminPermission>>;

export type AdminQueue = keyof typeof ADMIN_QUEUE_PERMISSIONS;
export interface AdminQueueRepository {
  listQueue(input: { queue: AdminQueue; limit: number; cursor?: string }): Promise<{
    items: Array<{ id: string; status: string; createdAt: string }>;
    nextCursor: string | null;
  }>;
}

const requiredReason = (value: string, code: string) => {
  try { return sanitizeAuditReason(value); } catch { throw new Error(code); }
};

export class AdminService {
  private readonly clock: () => Date;

  constructor(private readonly dependencies: {
    approvals: ApprovalRepository;
    governance: GovernanceProjection;
    entitlementConfig: VersionedEntitlementConfiguration;
    queues?: AdminQueueRepository;
    clock?: () => Date;
  }) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async requestSensitiveAction(actor: AdminActor, rawInput: ApprovalRequestInput, context: AdminRequestContext) {
    let input: ReturnType<typeof normalizeAndDeriveApproval>;
    try { input = normalizeAndDeriveApproval(approvalRequestSchema.parse(rawInput)); }
    catch { throw new Error("INVALID_APPROVAL"); }
    const permissions = sensitivePermissions[input.action];
    requirePermission(actor.role, permissions.request);
    requireRecentMfa(actor, this.clock());
    if (!Number.isInteger(input.payloadVersion) || input.payloadVersion < 1) throw new Error("INVALID_APPROVAL");
    const reason = requiredReason(input.reason, "INVALID_APPROVAL");
    if (input.action === "safety_evidence_access") {
      if (input.payload.actorUserId !== actor.userId) throw new Error("INVALID_APPROVAL");
    }
    const now = this.clock();
    if (!actor.adminSessionId) throw new Error("FORBIDDEN");
    const payloadHash = createHash("sha256").update(canonicalAdminJson({
      action: input.action, targetType: input.targetType, targetId: input.targetId,
      payloadVersion: input.payloadVersion, payload: input.payload,
    })).digest("hex");
    const created = await this.dependencies.approvals.create({
      requesterUserId: actor.userId,
      requesterAdminSessionId: actor.adminSessionId,
      requestId: context.requestId,
      action: input.action,
      requestPermission: permissions.request,
      approvalPermission: permissions.approve,
      targetType: input.targetType,
      targetId: input.targetId,
      payloadVersion: input.payloadVersion,
      payload: input.payload,
      payloadHash,
      reason,
      status: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
    }, context);
    return { id: created.id, status: created.status, expiresAt: created.expiresAt, payloadHash: created.payloadHash };
  }

  async listApprovalRequests(actor: AdminActor, input: { limit: number; cursor?: string }) {
    requirePermission(actor.role, "admin.console.read");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50 || (input.cursor && input.cursor.length > 1200)) {
      throw new Error("INVALID_CURSOR");
    }
    if (!this.dependencies.approvals.list) throw new Error("SERVICE_UNAVAILABLE");
    return this.dependencies.approvals.list({ actorUserId: actor.userId,
      allowedApprovalPermissions: ADMIN_ROLE_PERMISSIONS[actor.role], ...input });
  }

  async getApprovalRequest(actor: AdminActor, id: string) {
    requirePermission(actor.role, "admin.console.read");
    requireRecentMfa(actor, this.clock());
    if (!this.dependencies.approvals.get) throw new Error("SERVICE_UNAVAILABLE");
    const result = await this.dependencies.approvals.get({ actorUserId: actor.userId,
      allowedApprovalPermissions: ADMIN_ROLE_PERMISSIONS[actor.role], id });
    if (!result) throw new Error("ACTION_NOT_AVAILABLE");
    const action = result.action as ApprovalRequestInput["action"];
    const approvalPermission = result.approvalPermission as AdminPermission;
    requirePermission(actor.role, approvalPermission);
    try { return {
      id: result.id, requesterUserId: result.requesterUserId, action,
      requestPermission: result.requestPermission, approvalPermission,
      targetType: result.targetType, targetId: result.targetId, payloadVersion: result.payloadVersion,
      payloadHash: result.payloadHash, reason: result.reason, status: result.status,
      expiresAt: result.expiresAt, createdAt: result.createdAt,
      preview: approvalSafePreview(action, result.payload, { currency: result.currency }),
    }; }
    catch { throw new Error("ACTION_NOT_AVAILABLE"); }
  }

  async decideApproval(actor: AdminActor, approvalId: string, decision: "approved" | "rejected",
    rawReason: string, context: AdminRequestContext) {
    requirePermission(actor.role, "admin.console.read");
    requireRecentMfa(actor, this.clock());
    if (!actor.adminSessionId || !this.dependencies.approvals.decide) throw new Error("FORBIDDEN");
    if (!this.dependencies.approvals.get) throw new Error("SERVICE_UNAVAILABLE");
    const request = await this.dependencies.approvals.get({ actorUserId: actor.userId,
      allowedApprovalPermissions: ADMIN_ROLE_PERMISSIONS[actor.role], id: approvalId }) as {
      approvalPermission?: AdminPermission; requesterUserId?: string;
    } | null;
    if (!request) throw new Error("ACTION_NOT_AVAILABLE");
    if (!request.approvalPermission) throw new Error("FORBIDDEN");
    if (request.requesterUserId === actor.userId) throw new Error("SELF_APPROVAL_FORBIDDEN");
    requirePermission(actor.role, request.approvalPermission);
    return this.dependencies.approvals.decide({
      approvalId, approverUserId: actor.userId, approverAdminSessionId: actor.adminSessionId,
      decision, reason: requiredReason(rawReason, "INVALID_APPROVAL"), now: this.clock(), context,
    });
  }

  applyUserStatusAction(actor: AdminActor, targetUserId: string, input: {
    action: "warn" | "temporary_restriction" | "suspend" | "ban" | "restore";
    caseId: string;
    reason: string;
    idempotencyKey: string;
    expectedVersion: number;
    durationHours?: number;
  }, context: AdminRequestContext) {
    requirePermission(actor.role, "users.status.write");
    requireRecentMfa(actor, this.clock());
    const reason = requiredReason(input.reason, "INVALID_ACTION");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.idempotencyKey)
      || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0
      || !targetUserId || !input.caseId) throw new Error("INVALID_ACTION");
    return this.dependencies.governance.applyUserAction({
      ...input,
      actorUserId: actor.userId,
      actorRole: actor.role,
      targetUserId,
      reason,
      context,
    });
  }

  updateEntitlementConfiguration(actor: AdminActor, input: {
    entitlementKey: string;
    scope: "global_flag" | "free_default";
    expectedVersion: number;
    idempotencyKey: string;
    reason: string;
    grant: {
      kind: "boolean" | "quota" | "numeric";
      enabled: boolean;
      booleanValue: boolean | null;
      quotaLimit: number | null;
      numericValue: number | null;
      upgradeHint: string | null;
    };
  }, context: AdminRequestContext) {
    requirePermission(actor.role, "entitlements.config.write");
    requireRecentMfa(actor, this.clock());
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.idempotencyKey)
      || (input.scope === "global_flag" && (input.grant.booleanValue !== null || input.grant.quotaLimit !== null
        || input.grant.numericValue !== null || input.grant.upgradeHint !== null))) throw new Error("INVALID_CONFIGURATION");
    return this.dependencies.entitlementConfig.appendVersion({
      ...input,
      reason: requiredReason(input.reason, "INVALID_CONFIGURATION"),
      nextVersion: input.expectedVersion + 1,
      actorUserId: actor.userId,
      effectiveAt: this.clock(),
      context,
    });
  }

  async listQueues(actor: AdminActor, input: { limit: number; cursors?: Partial<Record<AdminQueue, string>> }) {
    requirePermission(actor.role, "admin.console.read");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) throw new Error("INVALID_CURSOR");
    if (!this.dependencies.queues) throw new Error("SERVICE_UNAVAILABLE");
    const allowed = (Object.entries(ADMIN_QUEUE_PERMISSIONS) as Array<[AdminQueue, AdminPermission]>)
      .filter(([, permission]) => hasPermission(actor.role, permission));
    for (const [queue] of allowed) {
      const cursor = input.cursors?.[queue];
      if (cursor !== undefined && (cursor.length < 8 || cursor.length > 1200)) throw new Error("INVALID_CURSOR");
    }
    const pages = await Promise.all(allowed.map(async ([queue]) => [queue,
      await this.dependencies.queues!.listQueue({ queue, limit: input.limit,
        ...(input.cursors?.[queue] ? { cursor: input.cursors[queue] } : {}) })] as const));
    return Object.fromEntries(pages) as Partial<Record<AdminQueue, Awaited<ReturnType<AdminQueueRepository["listQueue"]>>>>;
  }

  async listQueue(actor: AdminActor, input: { queue: AdminQueue; limit: number; cursor?: string }) {
    requirePermission(actor.role, "admin.console.read");
    const permission = ADMIN_QUEUE_PERMISSIONS[input.queue];
    if (!permission || !hasPermission(actor.role, permission)) throw new Error("FORBIDDEN");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50
      || (input.cursor !== undefined && (input.cursor.length < 8 || input.cursor.length > 1200))) {
      throw new Error("INVALID_CURSOR");
    }
    if (!this.dependencies.queues) throw new Error("SERVICE_UNAVAILABLE");
    return this.dependencies.queues.listQueue(input);
  }
}
