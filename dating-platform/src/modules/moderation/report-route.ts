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
const errorResponse = (code: string, status: number, headers?: HeadersInit) =>
  Response.json({ code, message: code }, { status, headers });

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

const mapError = (error: unknown) => {
  if (error instanceof BodyError) {
    if (error.code === "PAYLOAD_TOO_LARGE") return errorResponse(error.code, 413);
    if (error.code === "UNSUPPORTED_MEDIA_TYPE") return errorResponse(error.code, 415);
    return errorResponse("INVALID_REPORT", 400);
  }
  if (error instanceof ModerationError) {
    if (error.code === "INVALID_REPORT") return errorResponse(error.code, 400);
    if (error.code === "REPORT_NOT_AVAILABLE") return errorResponse(error.code, 404);
    if (error.code === "REPORT_IDEMPOTENCY_CONFLICT") return errorResponse(error.code, 409);
    if (error.code === "INVALID_CURSOR") return errorResponse(error.code, 400);
  }
  return errorResponse("INTERNAL_ERROR", 500);
};

export function createReportsHandler(input: {
  getSession: SessionReader;
  service: Pick<ReportService, "submit">;
  limiter: ReportRateLimiter;
}) {
  return async (request: Request) => {
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);
    let session: Session | null;
    try { session = await input.getSession(request.headers); } catch {
      return errorResponse("INTERNAL_ERROR", 500);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401);
    let decision: Awaited<ReturnType<ReportRateLimiter["consume"]>>;
    try {
      decision = await input.limiter.consume({ userId: session.user.id, key: "report.submit" });
    } catch {
      return errorResponse("SERVICE_UNAVAILABLE", 503);
    }
    if (!decision.allowed) {
      const retryAfter = Math.max(1, Math.min(86_400, Math.ceil(decision.retryAfterSeconds)));
      return errorResponse("RATE_LIMITED", 429, { "retry-after": String(retryAfter) });
    }
    try {
      const body = await readBoundedJson(request);
      const result = await input.service.submit(session.user.id, body);
      return Response.json(result, {
        status: 201,
        headers: { location: `/api/v1/reports/${result.id}` },
      });
    } catch (error) {
      return mapError(error);
    }
  };
}

export function createMyReportsHandler(input: {
  getSession: SessionReader;
  service: Pick<ReportService, "listOwned">;
}) {
  return async (request: Request) => {
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405);
    let session: Session | null;
    try { session = await input.getSession(request.headers); } catch {
      return errorResponse("INTERNAL_ERROR", 500);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401);
    const search = new URL(request.url).searchParams;
    for (const key of search.keys()) {
      if (!(["limit", "cursor"] as string[]).includes(key) || search.getAll(key).length !== 1) {
        return errorResponse("INVALID_CURSOR", 400);
      }
    }
    const rawLimit = search.get("limit");
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    const cursor = search.get("cursor") ?? undefined;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50
      || (cursor !== undefined && (cursor.length > 1200 || !cursorPattern.test(cursor)))) {
      return errorResponse("INVALID_CURSOR", 400);
    }
    try {
      return Response.json(await input.service.listOwned(session.user.id, { limit, cursor }));
    } catch (error) {
      return mapError(error);
    }
  };
}
