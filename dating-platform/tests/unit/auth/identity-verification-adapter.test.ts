import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryIdentityVerificationAdapter,
  HttpsIdentityVerificationAdapter,
  applyIdentityVerificationEvent,
  createIdentityVerificationHandler,
  verifyIdentityWebhookSignature,
  type IdentityVerificationAttempt,
  type IdentityVerificationEventStore,
} from "@/modules/auth/identity-verification-adapter";

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("identity verification", () => {
  const vendorResponse = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
    providerReference: "vendor-reference",
    redirectUrl: "https://identity.example.test/session/hosted",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });

  const hostedAdapter = (overrides: Record<string, unknown> = {}) =>
    new HttpsIdentityVerificationAdapter({
      endpoint: "https://identity.example.test",
      apiKey: "vendor-key",
      redirectOrigins: ["https://identity.example.test"],
    }, async () => vendorResponse(overrides));

  it("rejects an invalid webhook signature", () => {
    expect(verifyIdentityWebhookSignature("{}", "sha256=00", "webhook-secret")).toBe(false);
  });

  it("accepts the exact signed raw body", () => {
    const body = '{"eventId":"event-1"}';
    expect(verifyIdentityWebhookSignature(body, sign(body, "webhook-secret"), "webhook-secret"))
      .toBe(true);
  });

  it("creates and resolves hosted sessions in memory", async () => {
    const adapter = new InMemoryIdentityVerificationAdapter();
    const session = await adapter.createSession({ userId: crypto.randomUUID(), idempotencyKey: "memory-key-123" });

    expect(session.providerReference).toMatch(/^test_/);
    await expect(adapter.getResult(session.providerReference)).resolves.toEqual({ status: "pending" });
    await adapter.cancelSession(session.providerReference);
    await expect(adapter.getResult(session.providerReference)).resolves.toEqual({ status: "expired" });
  });

  it.each([
    "https://identity.example.test.evil/session",
    "https://user@identity.example.test/session",
    "https://identity.example.test:444/session",
  ])("rejects an untrusted hosted redirect %s", async (redirectUrl) => {
    await expect(hostedAdapter({ redirectUrl }).createSession({ userId: crypto.randomUUID(), idempotencyKey: "redirect-key-123" }))
      .rejects.toThrow("IDENTITY_PROVIDER_FAILED");
  });

  it.each([
    "not-a-date",
    new Date(Date.now() - 1_000).toISOString(),
    new Date(Date.now() + 31 * 60_000).toISOString(),
  ])("rejects invalid hosted expiry %s", async (expiresAt) => {
    await expect(hostedAdapter({ expiresAt }).createSession({ userId: crypto.randomUUID(), idempotencyKey: "expiry-key-123" }))
      .rejects.toThrow("IDENTITY_PROVIDER_FAILED");
  });

  it("rejects an oversized provider reference", async () => {
    await expect(hostedAdapter({ providerReference: "r".repeat(501) })
      .createSession({ userId: crypto.randomUUID(), idempotencyKey: "reference-key-123" }))
      .rejects.toThrow("IDENTITY_PROVIDER_FAILED");
  });

  it("sends the stable provider idempotency key in both header and body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(vendorResponse());
    const adapter = new HttpsIdentityVerificationAdapter({
      endpoint: "https://identity.example.test",
      apiKey: "vendor-key",
      redirectOrigins: ["https://identity.example.test"],
    }, fetch);
    const userId = crypto.randomUUID();
    await adapter.createSession({ userId, idempotencyKey: "provider-stable-key" });
    expect(fetch).toHaveBeenCalledWith(
      "https://identity.example.test/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({ "idempotency-key": "provider-stable-key" }),
        body: JSON.stringify({ userId, idempotencyKey: "provider-stable-key" }),
      }),
    );
  });

  it("handles duplicate events once and prevents an expired attempt overwriting state", async () => {
    const attempt: IdentityVerificationAttempt = {
      id: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      providerReference: "vendor-ref",
      status: "pending",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      createdAt: new Date("2025-12-01T00:00:00Z"),
    };
    const processed = new Set<string>();
    const store: IdentityVerificationEventStore = {
      async reserveEvent(_provider, received) {
        if (processed.has(received.eventId)) return false;
        processed.add(received.eventId);
        return true;
      },
      async findAttempt() { return attempt; },
      async findLatestAttempt() { return attempt; },
      async linkEvent() {},
      async updateAttemptStatus(_attemptId, status) { attempt.status = status; },
    };

    const event = { eventId: "event-1", providerReference: "vendor-ref", status: "approved" as const };
    await expect(applyIdentityVerificationEvent(store, "vendor", event, new Date("2026-02-01T00:00:00Z")))
      .resolves.toBe("ignored");
    await expect(applyIdentityVerificationEvent(store, "vendor", event, new Date("2026-02-01T00:00:00Z")))
      .resolves.toBe("duplicate");
    expect(attempt.status).toBe("pending");
  });

  it("rejects an unauthenticated identity-session request", async () => {
    const handler = createIdentityVerificationHandler({
      getSession: async () => null,
      getContext: async () => { throw new Error("not called"); },
      adapter: new InMemoryIdentityVerificationAdapter(),
      attemptStore: {
        findReusable: async () => { throw new Error("not called"); },
        availability: async () => { throw new Error("not called"); },
        beginIntent: async () => { throw new Error("not called"); },
        rejectIntent: async () => { throw new Error("not called"); },
        bindIntent: async () => { throw new Error("not called"); },
        markCompensated: async () => { throw new Error("not called"); },
        recordRetry: async () => { throw new Error("not called"); },
      },
      provider: "test",
    });

    const response = await handler(new Request("https://app.test/api/v1/auth/identity-verification", {
      method: "POST",
      headers: { "idempotency-key": "trusted-context-test" },
      body: JSON.stringify({ action: "pay" }),
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns a stable error when identity session lookup fails", async () => {
    const handler = createIdentityVerificationHandler({
      getSession: async () => { throw new Error("session backend details"); },
      getContext: async () => { throw new Error("not called"); },
      adapter: new InMemoryIdentityVerificationAdapter(),
      attemptStore: {
        findReusable: async () => null,
        availability: async () => null,
        beginIntent: async () => { throw new Error("not called"); },
        rejectIntent: async () => { throw new Error("not called"); },
        bindIntent: async () => { throw new Error("not called"); },
        markCompensated: async () => { throw new Error("not called"); },
        recordRetry: async () => { throw new Error("not called"); },
      },
      provider: "test",
    });
    const response = await handler(new Request("https://app.test/api/v1/auth/identity-verification", {
      method: "POST",
      body: JSON.stringify({ action: "pay" }),
    }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL_ERROR" } });
  });

  it("does not expose trusted-context failures", async () => {
    const handler = createIdentityVerificationHandler({
      getSession: async () => ({ user: { id: "user-id" } }),
      getContext: async () => { throw new Error("database details"); },
      adapter: new InMemoryIdentityVerificationAdapter(),
      attemptStore: {
        findReusable: async () => null,
        availability: async () => null,
        beginIntent: async () => { throw new Error("not called"); },
        rejectIntent: async () => { throw new Error("not called"); },
        bindIntent: async () => { throw new Error("not called"); },
        markCompensated: async () => { throw new Error("not called"); },
        recordRetry: async () => { throw new Error("not called"); },
      },
      provider: "test",
    });
    const response = await handler(new Request("https://app.test/api/v1/auth/identity-verification", {
      method: "POST",
      headers: { "idempotency-key": "trusted-context-test" },
      body: JSON.stringify({ action: "pay" }),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL_ERROR" } });
  });
});
