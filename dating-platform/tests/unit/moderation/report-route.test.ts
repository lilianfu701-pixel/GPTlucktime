import { describe, expect, it, vi } from "vitest";

import { ModerationError } from "@/modules/moderation/report-service";
import { createMyReportsHandler, createReportsHandler } from "@/modules/moderation/report-route";

const session = { user: { id: "00000000-0000-4000-8000-000000000501" } };
const TRACE_ID = "00000000-0000-4000-8000-000000000777";
const errorBody = (code: string, messageKey: string, retryable = false, fieldErrors?: readonly unknown[]) => ({
  code,
  messageKey,
  retryable,
  traceId: TRACE_ID,
  ...(fieldErrors ? { fieldErrors } : {}),
});
const report = {
  clientId: "00000000-0000-4000-8000-000000000101",
  targetProfileId: "00000000-0000-4000-8000-000000000201",
  reason: "HARASSMENT",
  locale: "en-US",
  explanation: "unwanted contact",
  evidenceReferences: [],
};

describe("POST /api/v1/reports", () => {
  const request = (body: string, headers: Record<string, string> = {}) => new Request("https://app.example/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": TRACE_ID, ...headers },
    body,
  });

  it("requires authentication before parsing or submitting", async () => {
    const submit = vi.fn();
    const limiter = { consume: vi.fn() };
    const handler = createReportsHandler({ getSession: async () => null, service: { submit }, limiter });
    const response = await handler(request("not-json"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(errorBody("UNAUTHORIZED", "errors.unauthorized"));
    expect(submit).not.toHaveBeenCalled();
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("does not misclassify session infrastructure failures as anonymous users", async () => {
    const handler = createReportsHandler({
      getSession: async () => { throw new Error("session SQL unavailable"); },
      service: { submit: vi.fn() },
      limiter: { consume: vi.fn() },
    });
    const response = await handler(request(JSON.stringify(report)));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(errorBody("INTERNAL_ERROR", "errors.internal", true));
  });

  it("enforces shared fail-closed rate limiting and bounded JSON", async () => {
    const submit = vi.fn();
    const denied = createReportsHandler({
      getSession: async () => session,
      service: { submit },
      limiter: { consume: async () => ({ allowed: false, retryAfterSeconds: 37 }) },
    });
    const limited = await denied(request(JSON.stringify(report)));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("37");
    expect(await limited.json()).toEqual(errorBody("RATE_LIMITED", "errors.rateLimited", true));

    const allowed = createReportsHandler({
      getSession: async () => session,
      service: { submit },
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    });
    const oversized = await allowed(request("x".repeat(16_385), { "content-length": "16385" }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual(errorBody("PAYLOAD_TOO_LARGE", "errors.payloadTooLarge", false, [
      { field: "body", messageKey: "errors.payloadTooLarge" },
    ]));
    const outage = createReportsHandler({
      getSession: async () => session,
      service: { submit },
      limiter: { consume: async () => { throw new Error("redis password and host"); } },
    });
    const unavailable = await outage(request(JSON.stringify(report)));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual(errorBody("SERVICE_UNAVAILABLE", "errors.serviceUnavailable", true));
  });

  it("returns 201 and Location with a minimal result", async () => {
    const result = {
      id: "00000000-0000-4000-8000-000000000601",
      status: "submitted" as const,
      createdAt: "2026-08-11T12:00:00.000Z",
      duplicate: false,
    };
    const submit = vi.fn(async () => result);
    const handler = createReportsHandler({
      getSession: async () => session,
      service: { submit },
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    });
    const response = await handler(request(JSON.stringify(report)));
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`/api/v1/reports/${result.id}`);
    expect(await response.json()).toEqual(result);
    expect(submit).toHaveBeenCalledWith(session.user.id, report);
  });

  it("uses stable non-enumerating and internal error responses", async () => {
    for (const [error, status, code, messageKey, retryable, fieldErrors] of [
      [new ModerationError("REPORT_NOT_AVAILABLE"), 404, "REPORT_NOT_AVAILABLE", "errors.reportNotAvailable", false],
      [new ModerationError("INVALID_REPORT"), 400, "INVALID_REPORT", "errors.invalidReport", false,
        [{ field: "body", messageKey: "errors.invalidReport" }]],
      [new ModerationError("REPORT_IDEMPOTENCY_CONFLICT"), 409, "REPORT_IDEMPOTENCY_CONFLICT",
        "errors.reportIdempotencyConflict", false],
      [new Error("select target_snapshot secret failed"), 500, "INTERNAL_ERROR", "errors.internal", true],
    ] as const) {
      const handler = createReportsHandler({
        getSession: async () => session,
        service: { submit: async () => { throw error; } },
        limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      });
      const response = await handler(request(JSON.stringify(report)));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(errorBody(code, messageKey, retryable, fieldErrors));
    }
  });

  it("does not echo an unvalidated request trace header", async () => {
    const handler = createReportsHandler({
      getSession: async () => null,
      service: { submit: vi.fn() },
      limiter: { consume: vi.fn() },
      createTraceId: () => TRACE_ID,
    });
    const response = await handler(request("not-json", { "x-request-id": "attacker-controlled" }));
    expect((await response.json()).traceId).toBe(TRACE_ID);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
  });
});

describe("GET /api/v1/me/reports", () => {
  it("passes only the authenticated owner with bounded cursor pagination", async () => {
    const listOwned = vi.fn(async () => ({
      reports: [{
        id: "00000000-0000-4000-8000-000000000701",
        status: "submitted" as const,
        reason: "HARASSMENT" as const,
        createdAt: "2026-08-11T12:00:00.000Z",
      }],
      nextCursor: null,
    }));
    const handler = createMyReportsHandler({
      getSession: async () => session,
      service: { listOwned },
      createTraceId: () => TRACE_ID,
    });
    const response = await handler(new Request("https://app.example/api/v1/me/reports?limit=10&cursor=abc.def"));
    expect(response.status).toBe(200);
    expect(listOwned).toHaveBeenCalledWith(session.user.id, { limit: 10, cursor: "abc.def" });
    const body = await response.json();
    expect(body).toEqual({ reports: expect.any(Array), nextCursor: null });
    expect(JSON.stringify(body)).not.toMatch(/target|snapshot|evidence|operator|confidence|caseId|workflow/iu);
  });

  it.each([
    "?limit=0",
    "?limit=51",
    "?limit=2.5",
    "?unknown=1",
    "?limit=10&limit=11",
    `?cursor=${"x".repeat(1201)}`,
  ])("rejects invalid pagination %s", async (query) => {
    const listOwned = vi.fn();
    const handler = createMyReportsHandler({
      getSession: async () => session,
      service: { listOwned },
      createTraceId: () => TRACE_ID,
    });
    const response = await handler(new Request(`https://app.example/api/v1/me/reports${query}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: "INVALID_CURSOR",
      messageKey: "errors.invalidCursor",
      retryable: false,
      traceId: TRACE_ID,
      fieldErrors: expect.any(Array),
    }));
    expect(listOwned).not.toHaveBeenCalled();
  });
});
