import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { deriveKey, hmacHex } from "./crypto";
import { env } from "./env";
import { errorResponseBody, httpStatusFor, successResponseBody } from "./errors";
import type { ErrorCode, FieldErrors } from "./errors";

export const CORRELATION_HEADER = "x-correlation-id";

/**
 * Accepts a caller-supplied correlation id so a client can tie its own logs to
 * ours, but only if it looks like an identifier. Anything else is replaced: an
 * unvalidated header would end up in every log line for the request.
 */
export function correlationIdFrom(request: Request): string {
  const supplied = request.headers.get(CORRELATION_HEADER);
  if (supplied && /^[A-Za-z0-9_-]{1,64}$/.test(supplied)) {
    return supplied;
  }
  return `req_${randomUUID()}`;
}

/**
 * A stable pseudonym for the caller's address.
 *
 * Operational records need to recognize a repeat caller without storing the
 * address itself. See 06-security-privacy-moderation.md section 8.
 */
export function requestIpHash(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip");
  if (!ip) {
    return undefined;
  }
  return hmacHex(deriveKey(env().SESSION_SECRET, "ip-pseudonym"), ip);
}

export function userAgentFrom(request: Request): string | undefined {
  return request.headers.get("user-agent")?.slice(0, 256) ?? undefined;
}

export function jsonSuccess<T>(
  data: T,
  correlationId: string,
  status = 200,
): NextResponse {
  return NextResponse.json(successResponseBody(data, correlationId), {
    status,
    headers: {
      [CORRELATION_HEADER]: correlationId,
      // No authenticated response may sit in a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}

export function jsonError(
  code: ErrorCode,
  correlationId: string,
  fieldErrors?: FieldErrors,
): NextResponse {
  return NextResponse.json(
    errorResponseBody(
      fieldErrors ? { code, correlationId, fieldErrors } : { code, correlationId },
    ),
    {
      status: httpStatusFor(code),
      headers: {
        [CORRELATION_HEADER]: correlationId,
        "Cache-Control": "private, no-store",
      },
    },
  );
}

/**
 * A business rule rejected well-formed input.
 *
 * Separate from `jsonError("INVALID_INPUT", ...)`, which answers 400 for input
 * that was malformed at the transport level. Doc 04 section 2 keeps the two
 * apart: 400 means the request could not be read, 422 means it was read and
 * found unacceptable.
 */
export function jsonUnprocessable(
  correlationId: string,
  fieldErrors: FieldErrors,
): NextResponse {
  return NextResponse.json(
    errorResponseBody({ code: "INVALID_INPUT", correlationId, fieldErrors }),
    {
      status: 422,
      headers: {
        [CORRELATION_HEADER]: correlationId,
        "Cache-Control": "private, no-store",
      },
    },
  );
}

export type ParsedBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse };

/**
 * Parses and validates a JSON body.
 *
 * Field messages come from the schema, which we author. Zod's raw issue list is
 * not forwarded wholesale, so an internal path or a received value cannot leak
 * into the response.
 */
export async function readJson<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  correlationId: string,
): Promise<ParsedBody<z.output<Schema>>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonError("INVALID_INPUT", correlationId),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: FieldErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "_";
      fieldErrors[field] ??= [];
      fieldErrors[field].push(issue.message);
    }
    return {
      ok: false,
      response: jsonError("INVALID_INPUT", correlationId, fieldErrors),
    };
  }

  return { ok: true, value: parsed.data };
}
