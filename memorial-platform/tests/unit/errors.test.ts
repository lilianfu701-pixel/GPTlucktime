import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  errorResponseBody,
  httpStatusFor,
  successResponseBody,
} from "@/lib/errors";
import type { ErrorCode } from "@/lib/errors";

/** The contract published in docs/memorial-platform/04-api-contracts.md section 10. */
const documentedCodes = [
  "AUTH_REQUIRED",
  "SESSION_EXPIRED",
  "FEATURE_DISABLED",
  "INVALID_INPUT",
  "MEMORIAL_NOT_FOUND",
  "MEMORIAL_FORBIDDEN",
  "INVITATION_REQUIRED",
  "RELATIONSHIP_NOT_ELIGIBLE",
  "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED",
  "DUPLICATE_CANDIDATE_FOUND",
  "RITUAL_NOT_ENABLED",
  "RITUAL_COMBINATION_PROHIBITED",
  "CONTENT_PENDING_REVIEW",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
  "EXPORT_IN_PROGRESS",
  "CALENDAR_NOT_CONFIGURED",
  "DEPENDENCY_UNAVAILABLE",
] as const;

describe("error code catalog", () => {
  it("publishes exactly the documented codes", () => {
    expect([...ERROR_CODES].sort()).toEqual([...documentedCodes].sort());
  });

  it("contains no duplicates", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("maps every code to a documented HTTP status", () => {
    const allowed = new Set([202, 400, 401, 403, 404, 409, 410, 422, 429, 503]);
    for (const code of ERROR_CODES) {
      expect(allowed.has(httpStatusFor(code))).toBe(true);
    }
  });

  it("hides an invite-only memorial behind 404 rather than 403", () => {
    // Returning 403 would confirm the memorial exists. See 04-api-contracts.md
    // section 2 and 06-security-privacy-moderation.md section 5.
    expect(httpStatusFor("MEMORIAL_NOT_FOUND")).toBe(404);
  });

  it("maps authentication and authorization failures apart", () => {
    expect(httpStatusFor("AUTH_REQUIRED")).toBe(401);
    expect(httpStatusFor("SESSION_EXPIRED")).toBe(401);
    expect(httpStatusFor("MEMORIAL_FORBIDDEN")).toBe(403);
    expect(httpStatusFor("RATE_LIMITED")).toBe(429);
    expect(httpStatusFor("DEPENDENCY_UNAVAILABLE")).toBe(503);
  });
});

describe("errorResponseBody", () => {
  it("matches the published failure envelope", () => {
    const body = errorResponseBody({
      code: "MEMORIAL_FORBIDDEN",
      correlationId: "req_123",
    });

    expect(Object.keys(body).sort()).toEqual(["error", "meta"]);
    expect(Object.keys(body.error).sort()).toEqual([
      "code",
      "fieldErrors",
      "message",
    ]);
    expect(body.error.code).toBe("MEMORIAL_FORBIDDEN");
    expect(body.meta.correlationId).toBe("req_123");
  });

  it("carries field errors for validation failures", () => {
    const body = errorResponseBody({
      code: "INVALID_INPUT",
      correlationId: "req_123",
      fieldErrors: { deathDate: ["Death date cannot precede birth date."] },
    });

    expect(body.error.fieldErrors["deathDate"]).toEqual([
      "Death date cannot precede birth date.",
    ]);
  });

  it("derives the message from the code so internal detail cannot leak", () => {
    // The caller cannot supply prose, so a stack trace, SQL fragment, object
    // storage key or provider response has no route into the response body.
    const body = errorResponseBody({
      code: "DEPENDENCY_UNAVAILABLE",
      correlationId: "req_123",
    });

    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.message).toBe(
      errorResponseBody({
        code: "DEPENDENCY_UNAVAILABLE",
        correlationId: "req_999",
      }).error.message,
    );
  });

  it("gives every code a non-empty public message", () => {
    for (const code of ERROR_CODES) {
      const body = errorResponseBody({ code, correlationId: "req_123" });
      expect(body.error.message.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps public messages free of internal vocabulary", () => {
    const forbidden = [
      "postgres",
      "redis",
      "drizzle",
      "select ",
      "s3://",
      "bucket",
      "stack",
      "risk score",
      "undefined",
    ];

    for (const code of ERROR_CODES) {
      const message = errorResponseBody({ code, correlationId: "req_123" })
        .error.message.toLowerCase();
      for (const term of forbidden) {
        expect(message).not.toContain(term);
      }
    }
  });

  it("serializes to JSON without extra properties", () => {
    const body = errorResponseBody({
      code: "RATE_LIMITED",
      correlationId: "req_123",
    });

    expect(JSON.parse(JSON.stringify(body))).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: body.error.message,
        fieldErrors: {},
      },
      meta: { correlationId: "req_123" },
    });
  });
});

describe("successResponseBody", () => {
  it("matches the published success envelope", () => {
    const body = successResponseBody(
      { memorialId: "uuid", slug: "wang-ming" },
      "req_123",
    );

    expect(JSON.parse(JSON.stringify(body))).toEqual({
      data: { memorialId: "uuid", slug: "wang-ming" },
      meta: { correlationId: "req_123" },
    });
  });

  it("accepts an empty payload without collapsing the envelope", () => {
    expect(successResponseBody({}, "req_123")).toEqual({
      data: {},
      meta: { correlationId: "req_123" },
    });
  });
});

describe("ErrorCode type", () => {
  it("accepts a documented code", () => {
    const code: ErrorCode = "RITUAL_NOT_ENABLED";
    expect(ERROR_CODES).toContain(code);
  });
});
