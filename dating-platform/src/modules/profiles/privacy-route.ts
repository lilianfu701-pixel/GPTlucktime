import { randomUUID } from "node:crypto";

import type { DataExportService } from "./data-export-service";
import type { DeletionService } from "./deletion-service";

type SessionReader = (headers: Headers) => Promise<{
  user: { id: string; emailVerified: boolean };
  session: { createdAt: Date };
} | null>;
type Limiter = { consume(input: { userId: string; key: "privacy.export" | "privacy.delete" }): Promise<{
  allowed: boolean; retryAfterSeconds: number;
}> };
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const messages: Record<string, string> = {
  METHOD_NOT_ALLOWED: "errors.methodNotAllowed", UNAUTHORIZED: "errors.unauthorized",
  INVALID_REQUEST: "errors.invalidRequest", INVALID_IDEMPOTENCY_KEY: "errors.invalidIdempotencyKey",
  PAYLOAD_TOO_LARGE: "errors.payloadTooLarge", UNSUPPORTED_MEDIA_TYPE: "errors.unsupportedMediaType",
  URI_TOO_LONG: "errors.uriTooLong", REAUTHENTICATION_REQUIRED: "errors.reauthenticationRequired",
  RATE_LIMITED: "errors.rateLimited", SERVICE_UNAVAILABLE: "errors.serviceUnavailable", CONFLICT: "errors.conflict",
  INTERNAL_ERROR: "errors.internal",
};
const error = (code: string, status: number, traceId: string, headers?: HeadersInit) => Response.json({ code,
  messageKey: messages[code] ?? messages.INTERNAL_ERROR, retryable: ["RATE_LIMITED", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR"].includes(code),
  traceId }, { status, headers: { ...Object.fromEntries(new Headers(headers)), "x-trace-id": traceId } });

async function emptyJson(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? "")) {
    throw new Error("UNSUPPORTED_MEDIA_TYPE");
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > 1024)) throw new Error("PAYLOAD_TOO_LARGE");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 1024) throw new Error("PAYLOAD_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("INVALID_REQUEST"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 0) {
    throw new Error("INVALID_REQUEST");
  }
}

const authorize = async (request: Request, getSession: SessionReader, limiter: Limiter,
  key: "privacy.export" | "privacy.delete", traceId: string, now: Date): Promise<{ response: Response } | { userId: string }> => {
  let session;
  try { session = await getSession(request.headers); } catch { return { response: error("INTERNAL_ERROR", 500, traceId) }; }
  if (!session) return { response: error("UNAUTHORIZED", 401, traceId) };
  const authenticatedAt = session.session.createdAt instanceof Date ? session.session.createdAt.getTime() : Number.NaN;
  const age = now.getTime() - authenticatedAt;
  if (!session.user.emailVerified || !Number.isFinite(age) || age < -60_000 || age > 30 * 60_000) {
    return { response: error("REAUTHENTICATION_REQUIRED", 403, traceId) };
  }
  let limit;
  try { limit = await limiter.consume({ userId: session.user.id, key }); } catch {
    return { response: error("SERVICE_UNAVAILABLE", 503, traceId) };
  }
  if (!limit.allowed) return { response: error("RATE_LIMITED", 429, traceId,
    { "retry-after": String(Math.max(1, Math.min(86_400, Math.ceil(limit.retryAfterSeconds)))) }) };
  return { userId: session.user.id };
};

const key = (request: Request) => request.headers.get("idempotency-key")?.trim() ?? "";
const mapFailure = (failure: unknown, traceId: string) => {
  const code = failure instanceof Error ? failure.message : "INTERNAL_ERROR";
  if (code === "PAYLOAD_TOO_LARGE") return error(code, 413, traceId);
  if (code === "UNSUPPORTED_MEDIA_TYPE") return error(code, 415, traceId);
  if (code === "INVALID_REQUEST") return error(code, 400, traceId);
  if (code === "EXPORT_NOT_AVAILABLE") return error("INVALID_REQUEST", 404, traceId);
  if (code === "DELETION_CONFLICT" || code === "DELETION_NOT_CANCELABLE") return error("CONFLICT", 409, traceId);
  return error("INTERNAL_ERROR", 500, traceId);
};

export function createExportHandler(deps: { getSession: SessionReader; service: Pick<DataExportService, "request" | "download">;
  limiter: Limiter; isAvailable?: () => boolean; createTraceId?: () => string; now?: () => Date }) {
  return async (request: Request) => {
    const traceId = (deps.createTraceId ?? randomUUID)();
    const now = deps.now?.() ?? new Date();
    const auth = await authorize(request, deps.getSession, deps.limiter, "privacy.export", traceId, now);
    if ("response" in auth) return auth.response;
    if (request.method !== "POST" && request.method !== "GET") return error("METHOD_NOT_ALLOWED", 405, traceId);
    if (deps.isAvailable && !deps.isAvailable()) return error("SERVICE_UNAVAILABLE", 503, traceId);
    if (request.method === "GET") {
      if (new TextEncoder().encode(request.url).byteLength > 2_048) return error("URI_TOO_LONG", 414, traceId);
      const search = new URL(request.url).searchParams;
      if ([...search.keys()].some((name) => name !== "jobId" || search.getAll(name).length !== 1)) return error("INVALID_REQUEST", 400, traceId);
      const jobId = search.get("jobId") ?? "";
      if (!/^[0-9a-f-]{36}$/iu.test(jobId)) return error("INVALID_REQUEST", 400, traceId);
      const token = request.headers.get("x-export-download-token") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return error("UNAUTHORIZED", 401, traceId);
      try {
        const download = await deps.service.download({ userId: auth.userId!, jobId, token, now });
        return new Response(Uint8Array.from(download.body).buffer, { headers: { "cache-control": "private, no-store",
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${download.filename}"`, "x-content-type-options": "nosniff",
          "x-trace-id": traceId } });
      } catch (failure) { return mapFailure(failure, traceId); }
    }
    const idempotencyKey = key(request);
    if (!idempotencyPattern.test(idempotencyKey)) return error("INVALID_IDEMPOTENCY_KEY", 400, traceId);
    try { await emptyJson(request); return Response.json(await deps.service.request({ userId: auth.userId!, idempotencyKey, now }),
      { status: 202, headers: { "cache-control": "private, no-store", "x-trace-id": traceId } }); } catch (failure) { return mapFailure(failure, traceId); }
  };
}

export function createDeletionHandler(deps: { getSession: SessionReader;
  service: Pick<DeletionService, "request" | "cancel" | "authenticateCancellation">;
  limiter: Limiter; isAvailable?: () => boolean; createTraceId?: () => string; now?: () => Date }) {
  return async (request: Request) => {
    const traceId = (deps.createTraceId ?? randomUUID)();
    const now = deps.now?.() ?? new Date();
    let userId: string;
    let cancellationToken: string | undefined;
    if (request.method === "DELETE") {
      const authorization = request.headers.get("authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
      if (!match) return error("UNAUTHORIZED", 401, traceId);
      cancellationToken = match[1];
      let owner;
      try { owner = await deps.service.authenticateCancellation({ token: cancellationToken, now }); } catch {
        return error("INTERNAL_ERROR", 500, traceId);
      }
      if (!owner) return error("UNAUTHORIZED", 401, traceId);
      userId = owner.userId;
      let limit;
      try { limit = await deps.limiter.consume({ userId, key: "privacy.delete" }); } catch {
        return error("SERVICE_UNAVAILABLE", 503, traceId);
      }
      if (!limit.allowed) return error("RATE_LIMITED", 429, traceId,
        { "retry-after": String(Math.max(1, Math.min(86_400, Math.ceil(limit.retryAfterSeconds)))) });
    } else {
      const auth = await authorize(request, deps.getSession, deps.limiter, "privacy.delete", traceId, now);
      if ("response" in auth) return auth.response;
      userId = auth.userId;
    }
    if (request.method !== "POST" && request.method !== "DELETE") return error("METHOD_NOT_ALLOWED", 405, traceId);
    if (request.method === "POST" && deps.isAvailable && !deps.isAvailable()) {
      return error("SERVICE_UNAVAILABLE", 503, traceId);
    }
    const idempotencyKey = key(request);
    if (!idempotencyPattern.test(idempotencyKey)) return error("INVALID_IDEMPOTENCY_KEY", 400, traceId);
    try {
      await emptyJson(request);
      if (request.method === "POST") {
        const result = await deps.service.request({ userId, idempotencyKey, now });
        return Response.json({ requestId: result.requestId, status: result.status, executeAt: result.executeAt,
          preserveHeldRecords: result.preserveHeldRecords, replayed: result.replayed }, { status: 202,
          headers: { "cache-control": "private, no-store", "x-trace-id": traceId } });
      }
      const result = await deps.service.cancel({ token: cancellationToken!, idempotencyKey });
      return Response.json(result, { status: 200,
        headers: { "cache-control": "private, no-store", "x-trace-id": traceId } });
    } catch (failure) { return mapFailure(failure, traceId); }
  };
}
