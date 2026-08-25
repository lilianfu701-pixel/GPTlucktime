// @vitest-environment node

import { describe, expect, it } from "vitest";

import { createHttpReceiptSender, parseRetryAfter } from "@/modules/messaging/http-receipt-client";
import type { RecoveredMessage } from "@/modules/messaging/realtime-client";

const message: RecoveredMessage = {
  id: "00000000-0000-4000-8000-000000000101",
  conversationId: "00000000-0000-4000-8000-000000000001",
  sequence: 1,
  body: "hello",
  sender: "them",
  createdAt: "2026-08-24T12:00:00.000Z",
};

describe("HTTP message receipt sender", () => {
  it("uses a same-origin strict JSON receipt request", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200 });
    };
    const send = createHttpReceiptSender(fetcher);

    await expect(send("read", message, "2026-08-24T12:01:00.000Z", new AbortController().signal)).resolves.toEqual({ ok: true });
    expect(calls[0]?.input).toBe("/api/v1/conversations/00000000-0000-4000-8000-000000000001/receipts");
    expect(calls[0]?.init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      messageId: message.id, kind: "read", at: "2026-08-24T12:01:00.000Z",
    });
  });

  it.each([401, 403, 404])("maps %i to NOT_AVAILABLE", async (status) => {
    const send = createHttpReceiptSender(async () => new Response("{}", { status }));
    await expect(send("delivered", message, message.createdAt, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: "NOT_AVAILABLE" });
  });

  it.each([429, 500, 503])("maps retryable HTTP %i with a bounded Retry-After", async (status) => {
    const send = createHttpReceiptSender(async () => new Response("{}", { status, headers: { "retry-after": "120" } }));
    await expect(send("delivered", message, message.createdAt, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: "RETRY_LATER", retryAfterMs: 60_000 });
  });

  it("maps network failures to RETRY_LATER but propagates aborts", async () => {
    const offline = createHttpReceiptSender(async () => { throw new Error("offline"); });
    await expect(offline("delivered", message, message.createdAt, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: "RETRY_LATER" });

    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    const aborted = createHttpReceiptSender(async () => { throw controller.signal.reason; });
    await expect(aborted("delivered", message, message.createdAt, controller.signal)).rejects.toThrow("Stopped");
  });

  it("parses numeric and HTTP-date Retry-After values within bounds", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    expect(parseRetryAfter("1.25", now)).toBe(1_250);
    expect(parseRetryAfter("Wed, 24 Aug 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 24 Aug 2026 13:30:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("invalid", now)).toBeUndefined();
  });
});
