import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AdminActor, AdminService } from "./admin-service";
import { approvalRequestSchema } from "./approval-contract";
import { sanitizeAuditReason } from "./audit-service";
import { requirePermission, requireRecentMfa, type AdminPermission } from "./permissions";

type AdminSessionReader = (headers: Headers) => Promise<AdminActor | null>;
type AdminMutationKey = "admin.user_action" | "admin.entitlement_config" | "admin.approval";
type AdminLimiter = { consume(input: { userId: string; key: AdminMutationKey }): Promise<{
  allowed: boolean; retryAfterSeconds: number;
}> };
type CommonDependencies = {
  getSession: AdminSessionReader;
  limiter: AdminLimiter;
  isTrustedOrigin(request: Request): boolean;
  resolveClientIp(request: Request): string;
  now?: () => Date;
  createTraceId?: () => string;
};

const MAX_ADMIN_JSON_BYTES = 16_384;
const tracePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const reasonSchema = z.string().trim().min(1).max(500).superRefine((value, context) => {
  try { sanitizeAuditReason(value); } catch { context.addIssue({ code: "custom", message: "sensitive reason" }); }
});

const traceId = (request: Request, create: () => string) => {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && tracePattern.test(supplied) ? supplied.toLowerCase() : create();
};

const errorResponse = (code: string, status: number, trace: string, headers?: HeadersInit) => Response.json({
  code,
  messageKey: `errors.${code === "INTERNAL_ERROR" ? "internal" : code.toLowerCase().replaceAll("_", ".")}`,
  retryable: status >= 500 || status === 429,
  traceId: trace,
}, { status, headers: { ...Object.fromEntries(new Headers(headers)), "x-trace-id": trace, "cache-control": "private, no-store" } });

class BodyError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE") { super(code); }
}

async function readBoundedJson(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? "")) {
    throw new BodyError("UNSUPPORTED_MEDIA_TYPE");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_ADMIN_JSON_BYTES)) {
    throw new BodyError("PAYLOAD_TOO_LARGE");
  }
  if (!request.body) throw new BodyError("INVALID_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ADMIN_JSON_BYTES) { await reader.cancel(); throw new BodyError("PAYLOAD_TOO_LARGE"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw new BodyError("INVALID_REQUEST");
  }
}

const mapError = (error: unknown, trace: string) => {
  if (error instanceof BodyError) return errorResponse(error.code,
    error.code === "PAYLOAD_TOO_LARGE" ? 413 : error.code === "UNSUPPORTED_MEDIA_TYPE" ? 415 : 400, trace);
  if (error instanceof z.ZodError) return errorResponse("INVALID_REQUEST", 400, trace);
  if (error instanceof Error) {
    if (error.message === "FORBIDDEN" || error.message === "RECENT_MFA_REQUIRED"
      || error.message === "SELF_APPROVAL_FORBIDDEN") return errorResponse("FORBIDDEN", 403, trace);
    if (error.message === "ACTION_NOT_AVAILABLE") return errorResponse("NOT_FOUND", 404, trace);
    if (error.message === "VERSION_CONFLICT" || error.message === "IDEMPOTENCY_CONFLICT") return errorResponse("CONFLICT", 409, trace);
    if (error.message.startsWith("INVALID_")) return errorResponse("INVALID_REQUEST", 400, trace);
  }
  return errorResponse("INTERNAL_ERROR", 500, trace);
};

async function authorize(request: Request, deps: CommonDependencies, permission: AdminPermission, trace: string): Promise<
  { ok: true; session: AdminActor } | { ok: false; response: Response }
> {
  let session: AdminActor | null;
  try { session = await deps.getSession(request.headers); } catch {
    return { ok: false, response: errorResponse("SERVICE_UNAVAILABLE", 503, trace) };
  }
  if (!session) return { ok: false, response: errorResponse("UNAUTHORIZED", 401, trace) };
  try {
    requirePermission(session.role, permission);
    requireRecentMfa(session, deps.now?.() ?? new Date());
  } catch {
    return { ok: false, response: errorResponse("FORBIDDEN", 403, trace) };
  }
  return { ok: true, session };
}

async function guardMutation(request: Request, deps: CommonDependencies, session: AdminActor,
  key: AdminMutationKey, trace: string) {
  if (!deps.isTrustedOrigin(request)) return errorResponse("FORBIDDEN", 403, trace);
  let decision;
  try { decision = await deps.limiter.consume({ userId: session.userId, key }); } catch {
    return errorResponse("SERVICE_UNAVAILABLE", 503, trace);
  }
  if (!decision.allowed) return errorResponse("RATE_LIMITED", 429, trace,
    { "retry-after": String(Math.max(1, Math.min(86_400, Math.ceil(decision.retryAfterSeconds)))) });
  return null;
}

const approvalDecisionSchema = z.object({ decision: z.enum(["approved", "rejected"]), reason: reasonSchema }).strict();
const uuidSchema = z.string().uuid();

type ApprovalRouteService = {
  requestSensitiveAction(actor: AdminActor, input: z.infer<typeof approvalRequestSchema>,
    context: { requestId: string; ipAddress: string }): Promise<unknown>;
  listApprovalRequests(actor: AdminActor, input: { limit: number; cursor?: string }): Promise<unknown>;
  getApprovalRequest(actor: AdminActor, id: string): Promise<unknown>;
  decideApproval(actor: AdminActor, id: string, decision: "approved" | "rejected", reason: string,
    context: { requestId: string; ipAddress: string }): Promise<unknown>;
};

export function createAdminApprovalCollectionHandler(deps: CommonDependencies & { service: Partial<ApprovalRouteService> }) {
  return async (request: Request): Promise<Response> => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "GET" && request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    try {
      const auth = await authorize(request, deps, "admin.console.read", trace);
      if (!auth.ok) return auth.response;
      if (request.method === "GET") {
        const url = new URL(request.url);
        const rawLimit = url.searchParams.get("limit") ?? "20";
        if (!/^\d{1,2}$/u.test(rawLimit)) throw new BodyError("INVALID_REQUEST");
        const limit = Number(rawLimit);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const result = await deps.service.listApprovalRequests!(auth.session, { limit, ...(cursor ? { cursor } : {}) });
        return Response.json(result, { headers: { "x-trace-id": trace, "cache-control": "private, no-store" } });
      }
      const guarded = await guardMutation(request, deps, auth.session, "admin.approval", trace);
      if (guarded) return guarded;
      const body = approvalRequestSchema.parse(await readBoundedJson(request));
      const result = await deps.service.requestSensitiveAction!(auth.session, body, {
        requestId: trace, ipAddress: deps.resolveClientIp(request),
      });
      return Response.json(result, { status: 201, headers: { "x-trace-id": trace, "cache-control": "private, no-store" } });
    } catch (error) { return mapError(error, trace); }
  };
}

export function createAdminApprovalDetailHandler(deps: CommonDependencies & { service: Partial<ApprovalRouteService> }) {
  return async (request: Request, context: { params: Promise<{ approvalId: string }> }): Promise<Response> => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    try {
      const auth = await authorize(request, deps, "admin.console.read", trace);
      if (!auth.ok) return auth.response;
      const { approvalId } = await context.params;
      if (!uuidSchema.safeParse(approvalId).success) return errorResponse("NOT_FOUND", 404, trace);
      const result = await deps.service.getApprovalRequest!(auth.session, approvalId);
      return Response.json(result, { headers: { "x-trace-id": trace, "cache-control": "private, no-store" } });
    } catch (error) { return mapError(error, trace); }
  };
}

export function createAdminApprovalDecisionHandler(deps: CommonDependencies & { service: Partial<ApprovalRouteService> }) {
  return async (request: Request, context: { params: Promise<{ approvalId: string }> }): Promise<Response> => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    try {
      const auth = await authorize(request, deps, "admin.console.read", trace);
      if (!auth.ok) return auth.response;
      const guarded = await guardMutation(request, deps, auth.session, "admin.approval", trace);
      if (guarded) return guarded;
      const { approvalId } = await context.params;
      if (!uuidSchema.safeParse(approvalId).success) return errorResponse("NOT_FOUND", 404, trace);
      const body = approvalDecisionSchema.parse(await readBoundedJson(request));
      const result = await deps.service.decideApproval!(auth.session, approvalId, body.decision, body.reason, {
        requestId: trace, ipAddress: deps.resolveClientIp(request),
      });
      return Response.json(result, { headers: { "x-trace-id": trace, "cache-control": "private, no-store" } });
    } catch (error) { return mapError(error, trace); }
  };
}

const userActionSchema = z.object({
  action: z.enum(["warn", "temporary_restriction", "suspend", "ban", "restore"]),
  caseId: z.string().uuid(),
  reason: reasonSchema,
  expectedVersion: z.number().int().min(0),
  durationHours: z.number().int().min(1).max(24 * 365).optional(),
}).strict();

const grantSchema = z.object({
  kind: z.enum(["boolean", "quota", "numeric"]),
  enabled: z.boolean(),
  booleanValue: z.boolean().nullable(),
  quotaLimit: z.number().int().min(0).max(1_000_000).nullable(),
  numericValue: z.number().min(0).max(1_000_000).nullable(),
  upgradeHint: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u).nullable(),
}).strict();

const entitlementSchema = z.object({
  entitlementKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u),
  scope: z.enum(["global_flag", "free_default"]),
  expectedVersion: z.number().int().min(0),
  reason: reasonSchema,
  grant: grantSchema,
}).strict().superRefine((value, context) => {
  if (value.scope === "global_flag" && (value.grant.booleanValue !== null || value.grant.quotaLimit !== null
    || value.grant.numericValue !== null || value.grant.upgradeHint !== null)) {
    context.addIssue({ code: "custom", message: "global flag values must be null" });
  }
  if (value.scope === "free_default") {
    const valid = value.grant.kind === "boolean"
      ? value.grant.booleanValue !== null && value.grant.quotaLimit === null && value.grant.numericValue === null
      : value.grant.kind === "quota"
        ? value.grant.booleanValue === null && value.grant.numericValue === null && value.grant.quotaLimit !== null
        : value.grant.booleanValue === null && value.grant.quotaLimit === null && value.grant.numericValue !== null;
    if (!valid) context.addIssue({ code: "custom", message: "invalid grant shape" });
  }
});

export function createAdminUserActionsHandler(deps: CommonDependencies & {
  service: Pick<AdminService, "applyUserStatusAction">;
}) {
  return async (request: Request, context: { params: Promise<{ userId: string }> }): Promise<Response> => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    try {
      const auth = await authorize(request, deps, "users.status.write", trace);
      if (!auth.ok) return auth.response;
      const guarded = await guardMutation(request, deps, auth.session, "admin.user_action", trace);
      if (guarded) return guarded;
      const { userId } = await context.params;
      if (!z.string().uuid().safeParse(userId).success) return errorResponse("NOT_FOUND", 404, trace);
      const body = userActionSchema.parse(await readBoundedJson(request));
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
      if (!idempotencyPattern.test(idempotencyKey)) throw new BodyError("INVALID_REQUEST");
      const result = await deps.service.applyUserStatusAction(auth.session, userId, { ...body, idempotencyKey }, {
        requestId: trace, ipAddress: deps.resolveClientIp(request),
      });
      return Response.json(result, { headers: { "x-trace-id": trace, "cache-control": "private, no-store" } });
    } catch (error) { return mapError(error, trace); }
  };
}

export function createAdminEntitlementsHandler(deps: CommonDependencies & {
  service: Pick<AdminService, "updateEntitlementConfiguration">;
}) {
  return async (request: Request): Promise<Response> => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    try {
      const auth = await authorize(request, deps, "entitlements.config.write", trace);
      if (!auth.ok) return auth.response;
      const guarded = await guardMutation(request, deps, auth.session, "admin.entitlement_config", trace);
      if (guarded) return guarded;
      const body = entitlementSchema.parse(await readBoundedJson(request));
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
      if (!idempotencyPattern.test(idempotencyKey)) throw new BodyError("INVALID_REQUEST");
      const result = await deps.service.updateEntitlementConfiguration(auth.session, { ...body, idempotencyKey }, {
        requestId: trace, ipAddress: deps.resolveClientIp(request),
      });
      return Response.json(result, { status: 201, headers: { "x-trace-id": trace, "cache-control": "private, no-store" } });
    } catch (error) { return mapError(error, trace); }
  };
}

type SensitiveAccessService = {
  readEvidenceMetadata(actor: AdminActor, target: { kind: "report" | "safety" | "legal" | "approved_grant";
    caseId: string; reportId: string; evidenceId?: string }, reason: string,
    context: { requestId: string; ipAddress: string }): Promise<unknown>;
  readMessageMetadata(actor: AdminActor, target: { kind: "report" | "safety" | "legal" | "approved_grant";
    caseId: string; reportId: string; messageId: string }, reason: string,
    context: { requestId: string; ipAddress: string }): Promise<unknown>;
};
const workflowSchema = z.enum(["report", "safety", "legal", "approved_grant"]);

async function guardSensitiveRead(deps: CommonDependencies, session: AdminActor, trace: string) {
  try {
    const decision = await deps.limiter.consume({ userId: session.userId, key: "admin.approval" });
    return decision.allowed ? null : errorResponse("RATE_LIMITED", 429, trace,
      { "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterSeconds))) });
  } catch { return errorResponse("SERVICE_UNAVAILABLE", 503, trace); }
}

export function createAdminEvidenceReadHandler(deps: CommonDependencies & { sensitiveAccess: SensitiveAccessService }) {
  return async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    try {
      const auth = await authorize(request, deps, "messages.private.read", trace);
      if (!auth.ok) return auth.response;
      const guarded = await guardSensitiveRead(deps, auth.session, trace);
      if (guarded) return guarded;
      const { caseId } = await context.params;
      const url = new URL(request.url);
      const parsed = z.object({ caseId: uuidSchema, reportId: uuidSchema, evidenceId: uuidSchema.optional(),
        kind: workflowSchema, reason: reasonSchema }).strict().parse({ caseId,
        reportId: url.searchParams.get("reportId"), evidenceId: url.searchParams.get("evidenceId") ?? undefined,
        kind: url.searchParams.get("kind"), reason: url.searchParams.get("reason") });
      const result = await deps.sensitiveAccess.readEvidenceMetadata(auth.session, parsed, parsed.reason, {
        requestId: trace, ipAddress: deps.resolveClientIp(request),
      });
      return Response.json(result, { headers: { "x-trace-id": trace, "cache-control": "private, no-store" } });
    } catch (error) { return mapError(error, trace); }
  };
}

export function createAdminPrivateMessageReadHandler(deps: CommonDependencies & { sensitiveAccess: SensitiveAccessService }) {
  return async (request: Request, context: { params: Promise<{ messageId: string }> }) => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    try {
      const auth = await authorize(request, deps, "messages.private.read", trace);
      if (!auth.ok) return auth.response;
      const guarded = await guardSensitiveRead(deps, auth.session, trace);
      if (guarded) return guarded;
      const { messageId } = await context.params;
      const url = new URL(request.url);
      const parsed = z.object({ messageId: uuidSchema, caseId: uuidSchema, reportId: uuidSchema,
        kind: workflowSchema, reason: reasonSchema }).strict().parse({ messageId,
        caseId: url.searchParams.get("caseId"), reportId: url.searchParams.get("reportId"),
        kind: url.searchParams.get("kind"), reason: url.searchParams.get("reason") });
      const result = await deps.sensitiveAccess.readMessageMetadata(auth.session, parsed, parsed.reason, {
        requestId: trace, ipAddress: deps.resolveClientIp(request),
      });
      return Response.json(result, { headers: { "x-trace-id": trace, "cache-control": "private, no-store" } });
    } catch (error) { return mapError(error, trace); }
  };
}
