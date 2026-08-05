import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  InMemoryIdentityVerificationAdapter,
  applyIdentityVerificationEvent,
  createIdentityVerificationHandler,
  verifyIdentityWebhookSignature,
  type IdentityVerificationAttempt,
  type IdentityVerificationEventStore,
} from "@/modules/auth/identity-verification-adapter";

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("identity verification", () => {
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
    const session = await adapter.createSession({ userId: crypto.randomUUID() });

    expect(session.providerReference).toMatch(/^test_/);
    await expect(adapter.getResult(session.providerReference)).resolves.toEqual({ status: "pending" });
    await adapter.cancelSession(session.providerReference);
    await expect(adapter.getResult(session.providerReference)).resolves.toEqual({ status: "expired" });
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
      createAttempt: async () => { throw new Error("not called"); },
      provider: "test",
    });

    const response = await handler(new Request("https://app.test/api/v1/auth/identity-verification", {
      method: "POST",
      body: JSON.stringify({ action: "pay" }),
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHORIZED" } });
  });

  it("does not expose trusted-context failures", async () => {
    const handler = createIdentityVerificationHandler({
      getSession: async () => ({ user: { id: "user-id" } }),
      getContext: async () => { throw new Error("database details"); },
      adapter: new InMemoryIdentityVerificationAdapter(),
      createAttempt: async () => undefined,
      provider: "test",
    });
    const response = await handler(new Request("https://app.test/api/v1/auth/identity-verification", {
      method: "POST",
      body: JSON.stringify({ action: "pay" }),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL_ERROR" } });
  });
});
