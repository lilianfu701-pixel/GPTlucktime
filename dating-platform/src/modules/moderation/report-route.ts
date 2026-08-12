import { randomUUID } from "node:crypto";

import type { ReportService } from "./report-service";
import { ModerationError } from "./report-service";

type Session = { user: { id: string } };
type SessionReader = (headers: Headers) => Promise<Session | null>;

export interface ReportRateLimiter {
  consume(input: { userId: string; key: "report.submit" }): Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
  }>;
}

const MAX_REPORT_JSON_BYTES = 16_384;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
type FieldError = { field: string; messageKey: string };
const messageKeys: Record<string, string> = {
  METHOD_NOT_ALLOWED: "errors.methodNotAllowed",
  UNAUTHORIZED: "errors.unauthorized",
  INVALID_REPORT: "errors.invalidReport",
  PAYLOAD_TOO_LARGE: "errors.payloadTooLarge",
  UNSUPPORTED_MEDIA_TYPE: "errors.unsupportedMediaType",
  REPORT_NOT_AVAILABLE: "errors.reportNotAvailable",
  REPORT_IDEMPOTENCY_CONFLICT: "errors.reportIdempotencyConflict",
  INVALID_CURSOR: "errors.invalidCursor",
  RATE_LIMITED: "errors.rateLimited",
  SERVICE_UNAVAILABLE: "errors.serviceUnavailable",
  INTERNAL_ERROR: "errors.internal",
};
const retryableCodes = new Set(["RATE_LIMITED", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR"]);
const traceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requestTraceId = (request: Request, createTraceId: () => string) => {
  const requested = request.headers.get("x-request-id")?.trim();
  return requested && traceIdPattern.test(requested) ? requested.toLowerCase() : createTraceId();
};
const errorResponse = (
  code: string,
  status: number,
  traceId: string,
  options: { headers?: HeadersInit; fieldErrors?: FieldError[] } = {},
) => Response.json({
  code,
  messageKey: messageKeys[code] ?? "errors.internal",
  retryable: retryableCodes.has(code),
  traceId,
  ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
}, {
  status,
  headers: { ...Object.fromEntries(new Headers(options.headers)), "x-trace-id": traceId },
});

class BodyError extends Error {
  constructor(readonly code: "INVALID_REPORT" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE") {
    super(code);
  }
}

async function readBoundedJson(request: Request) {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new BodyError("UNSUPPORTED_MEDIA_TYPE");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) throw new BodyError("INVALID_REPORT");
    if (Number(declared) > MAX_REPORT_JSON_BYTES) throw new BodyError("PAYLOAD_TOO_LARGE");
  }
  if (!request.body) throw new BodyError("INVALID_REPORT");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPORT_JSON_BYTES) {
        await reader.cancel();
        throw new BodyError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw new BodyError("INVALID_REPORT");
  }
}

const mapError = (error: unknown, traceId: string) => {
  if (error instanceof BodyError) {
    const options = { fieldErrors: [{ field: "body", messageKey: messageKeys[error.code]! }] };
    if (error.code === "PAYLOAD_TOO_LARGE") return errorResponse(error.code, 413, traceId, options);
    if (error.code === "UNSUPPORTED_MEDIA_TYPE") return errorResponse(error.code, 415, traceId, options);
    return errorResponse("INVALID_REPORT", 400, traceId, options);
  }
  if (error instanceof ModerationError) {
    if (error.code === "INVALID_REPORT") return errorResponse(error.code, 400, traceId, {
      fieldErrors: [{ field: "body", messageKey: messageKeys.INVALID_REPORT! }],
    });
    if (error.code === "REPORT_NOT_AVAILABLE") return errorResponse(error.code, 404, traceId);
    if (error.code === "REPORT_IDEMPOTENCY_CONFLICT") return errorResponse(error.code, 409, traceId);
    if (error.code === "INVALID_CURSOR") return errorResponse(error.code, 400, traceId, {
      fieldErrors: [{ field: "cursor", messageKey: messageKeys.INVALID_CURSOR! }],
    });
  }
  return errorResponse("INTERNAL_ERROR", 500, traceId);
};

export function createReportsHandler(input: {
  getSession: SessionReader;
  service: Pick<ReportService, "submit">;
  limiter: ReportRateLimiter;
  createTraceId?: () => string;
}) {
  return async (request: Request) => {
    const traceId = requestTraceId(request, input.createTraceId ?? randomUUID);
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405, traceId);
    let session: Session | null;
    try { session = await input.getSession(request.headers); } catch {
      return errorResponse("INTERNAL_ERROR", 500, traceId);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401, traceId);
    let decision: Awaited<ReturnType<ReportRateLimiter["consume"]>>;
    try {
      decision = await input.limiter.consume({ userId: session.user.id, key: "report.submit" });
    } catch {
      return errorResponse("SERVICE_UNAVAILABLE", 503, traceId);
    }
    if (!decision.allowed) {
      const retryAfter = Math.max(1, Math.min(86_400, Math.ceil(decision.retryAfterSeconds)));
      return errorResponse("RATE_LIMITED", 429, traceId, { headers: { "retry-after": String(retryAfter) } });
    }
    try {
      const body = await readBoundedJson(request);
      const result = await input.service.submit(session.user.id, body);
      return Response.json(result, {
        status: 201,
        headers: { location: `/api/v1/reports/${result.id}` },
      });
    } catch (error) {
      return mapError(error, traceId);
    }
  };
}

export function createMyReportsHandler(input: {
  getSession: SessionReader;
  service: Pick<ReportService, "listOwned">;
  createTraceId?: () => string;
}) {
  return async (request: Request) => {
    const traceId = requestTraceId(request, input.createTraceId ?? randomUUID);
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405, traceId);
    let session: Session | null;
    try { session = await input.getSession(request.headers); } catch {
      return errorResponse("INTERNAL_ERROR", 500, traceId);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401, traceId);
    const search = new URL(request.url).searchParams;
    for (const key of search.keys()) {
      if (!(["limit", "cursor"] as string[]).includes(key) || search.getAll(key).length !== 1) {
        return errorResponse("INVALID_CURSOR", 400, traceId, {
          fieldErrors: [{ field: key, messageKey: messageKeys.INVALID_CURSOR! }],
        });
      }
    }
    const rawLimit = search.get("limit");
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    const cursor = search.get("cursor") ?? undefined;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50
      || (cursor !== undefined && (cursor.length > 1200 || !cursorPattern.test(cursor)))) {
      return errorResponse("INVALID_CURSOR", 400, traceId, {
        fieldErrors: [{ field: "cursor", messageKey: messageKeys.INVALID_CURSOR! }],
      });
    }
    try {
      return Response.json(await input.service.listOwned(session.user.id, { limit, cursor }));
    } catch (error) {
      return mapError(error, traceId);
    }
  };
}
