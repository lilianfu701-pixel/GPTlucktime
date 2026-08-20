import { describe, expect, it, vi } from "vitest";

import { createDeletionHandler, createExportHandler } from "@/modules/profiles/privacy-route";

const request = (url: string, method = "POST", body = "{}", headers: Record<string, string> = {}) =>
  new Request(url, { method, body: method === "GET" ? undefined : body,
    headers: { "content-type": "application/json", "idempotency-key": "privacy-request-0001", ...headers } });
const now = new Date("2026-08-20T18:00:00.000Z");
const verifiedSession = (createdAt = new Date("2026-08-20T17:55:00.000Z")) => ({
  user: { id: "owner", emailVerified: true }, session: { createdAt },
});

describe("privacy routes", () => {
  it("authenticates export before parsing an invalid body", async () => {
    const service = { request: vi.fn(), download: vi.fn() };
    const handler = createExportHandler({ getSession: async () => null, service, limiter: { consume: vi.fn() } });
    const response = await handler(request("https://app.example/api/v1/me/export", "POST", "{"));
    expect(response.status).toBe(401);
    expect(service.request).not.toHaveBeenCalled();
  });

  it("accepts only a bounded empty export command and server session owner", async () => {
    const service = { request: vi.fn(async () => ({ jobId: "export-1", status: "pending" as const, replayed: false })),
      download: vi.fn() };
    const handler = createExportHandler({ getSession: async () => verifiedSession(), service,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, now: () => now });
    const response = await handler(request("https://app.example/api/v1/me/export"));
    expect(response.status).toBe(202);
    expect(service.request).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner",
      idempotencyKey: "privacy-request-0001" }));
  });

  it("fails closed before accepting an export when the complete worker configuration is unavailable", async () => {
    const service = { request: vi.fn(), download: vi.fn() };
    const handler = createExportHandler({ getSession: async () => verifiedSession(), service,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, isAvailable: () => false,
      createTraceId: () => "trace-storage-unavailable", now: () => now });
    const response = await handler(request("https://app.example/api/v1/me/export"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE", retryable: true,
      traceId: "trace-storage-unavailable" });
    expect(service.request).not.toHaveBeenCalled();
  });

  it("requests deletion with recent auth and cancels only with the scoped cancellation credential", async () => {
    const service = { request: vi.fn(async () => ({ requestId: "delete-1", status: "cooling_off" as const,
      executeAt: new Date("2026-09-04T00:00:00Z"), preserveHeldRecords: false, replayed: false,
      cancellationToken: "c".repeat(43) })),
      authenticateCancellation: vi.fn(async (input: { token: string }) =>
        input.token === "c".repeat(43) ? { userId: "owner" } : null),
      cancel: vi.fn(async (input: { token: string; idempotencyKey: string }) => ({ ...input, canceled: true })) };
    const handler = createDeletionHandler({ getSession: async () => verifiedSession(), service,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, now: () => now });
    const accepted = await handler(request("https://app.example/api/v1/me/delete"));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ requestId: "delete-1", status: "cooling_off",
      executeAt: "2026-09-04T00:00:00.000Z", preserveHeldRecords: false, replayed: false });
    expect((await handler(request("https://app.example/api/v1/me/delete", "DELETE"))).status).toBe(401);
    const canceled = await handler(request("https://app.example/api/v1/me/delete", "DELETE", "{}",
      { authorization: `Bearer ${"c".repeat(43)}` }));
    expect(canceled.status).toBe(200);
    expect(service.request).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner" }));
    expect(service.cancel).toHaveBeenCalledWith({ token: "c".repeat(43), idempotencyKey: "privacy-request-0001" });
  });

  it("fails closed before deletion when scoped credential delivery is unavailable", async () => {
    const service = { request: vi.fn(), authenticateCancellation: vi.fn(), cancel: vi.fn() };
    const handler = createDeletionHandler({ getSession: async () => verifiedSession(), service,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      isAvailable: () => false, now: () => now });
    expect((await handler(request("https://app.example/api/v1/me/delete"))).status).toBe(503);
    expect(service.request).not.toHaveBeenCalled();
  });

  it("returns a stable non-retryable conflict when deletion cannot be canceled", async () => {
    const handler = createDeletionHandler({ getSession: async () => verifiedSession(),
      service: { request: vi.fn(), authenticateCancellation: async () => ({ userId: "owner" }),
        cancel: async () => { throw new Error("DELETION_NOT_CANCELABLE"); } },
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      createTraceId: () => "trace-cancel-conflict", now: () => now });

    const response = await handler(request("https://app.example/api/v1/me/delete", "DELETE", "{}",
      { authorization: `Bearer ${"c".repeat(43)}` }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CONFLICT", messageKey: "errors.conflict",
      retryable: false, traceId: "trace-cancel-conflict" });
  });

  it.each([
    ["unverified email", { user: { id: "owner", emailVerified: false }, session: { createdAt: now } }],
    ["stale authentication", verifiedSession(new Date("2026-08-20T17:29:59.999Z"))],
  ])("rejects %s before rate limiting or parsing", async (_label, session) => {
    const limiter = { consume: vi.fn() };
    const service = { request: vi.fn(), download: vi.fn() };
    const handler = createExportHandler({ getSession: async () => session, service, limiter, now: () => now });

    const response = await handler(request("https://app.example/api/v1/me/export", "POST", "{"));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "REAUTHENTICATION_REQUIRED",
      messageKey: "errors.reauthenticationRequired", retryable: false });
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(service.request).not.toHaveBeenCalled();
  });

  it("authenticates unsupported methods before returning a stable envelope", async () => {
    const service = { request: vi.fn(), download: vi.fn() };
    const handler = createExportHandler({ getSession: async () => null, service, limiter: { consume: vi.fn() }, now: () => now });
    expect((await handler(request("https://app.example/api/v1/me/export", "PATCH"))).status).toBe(401);
  });

  it("bounds the authenticated export URL before parsing query parameters", async () => {
    const service = { request: vi.fn(), download: vi.fn() };
    const handler = createExportHandler({ getSession: async () => verifiedSession(), service,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, now: () => now });
    const response = await handler(request(`https://app.example/api/v1/me/export?jobId=${"a".repeat(2050)}`, "GET"));
    expect(response.status).toBe(414);
    expect(await response.json()).toMatchObject({ code: "URI_TOO_LONG", messageKey: "errors.uriTooLong" });
  });

  it("streams a decrypted owner-bound export without exposing storage coordinates", async () => {
    const body = new TextEncoder().encode('{"schemaVersion":1,"data":{}}');
    const service = { request: vi.fn(), download: vi.fn(async () => ({ body,
      filename: "heartline-data-export.json" })) };
    const handler = createExportHandler({ getSession: async () => verifiedSession(), service,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, now: () => now });
    const jobId = "11111111-1111-4111-8111-111111111111";
    const response = await handler(request(`https://app.example/api/v1/me/export?jobId=${jobId}`, "GET", "{}",
      { "x-export-download-token": "d".repeat(43) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="heartline-data-export.json"');
    expect(await response.text()).toBe(new TextDecoder().decode(body));
    expect(service.download).toHaveBeenCalledWith({ userId: "owner", jobId,
      token: "d".repeat(43), now });
  });

  it("does not expose storage failures from the download route", async () => {
    const handler = createExportHandler({ getSession: async () => verifiedSession(),
      service: { request: vi.fn(), download: async () => { throw new Error("S3_SECRET_PROVIDER_DETAIL"); } },
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      createTraceId: () => "trace-download-failure", now: () => now });
    const response = await handler(request("https://app.example/api/v1/me/export?jobId=11111111-1111-4111-8111-111111111111",
      "GET", "{}", { "x-export-download-token": "d".repeat(43) }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "INTERNAL_ERROR", messageKey: "errors.internal",
      retryable: true, traceId: "trace-download-failure" });
  });
});
