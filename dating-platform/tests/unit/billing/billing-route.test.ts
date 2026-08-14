import { describe, expect, it, vi } from "vitest";

import { createCheckoutHandler, createPlansHandler, createStripeWebhookHandler,
  createSubscriptionHandler } from "@/modules/billing/billing-route";
import { BillingError } from "@/modules/billing/checkout-service";

const TRACE_ID = "00000000-0000-4000-8000-000000000099";

describe("billing routes", () => {
  it("rejects unsupported methods before any dependency", async () => {
    const getSession = vi.fn();
    const handler = createCheckoutHandler({ getSession, authorizePayment: vi.fn(),
      service: { create: vi.fn() }, limiter: { consume: vi.fn() }, createTraceId: () => TRACE_ID });
    const response = await handler(new Request("https://app.example/api/v1/checkout-sessions", { method: "GET" }));
    expect(response.status).toBe(405);
    expect(getSession).not.toHaveBeenCalled();
  });
  it("authenticates checkout before reading a bounded JSON body", async () => {
    const service = { create: vi.fn() };
    const authorizePayment = vi.fn();
    const handler = createCheckoutHandler({ getSession: async () => null, authorizePayment,
      service, limiter: { consume: vi.fn() }, createTraceId: () => TRACE_ID });
    const response = await handler(new Request("https://app.example/api/v1/checkout-sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "not-json",
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "UNAUTHORIZED", messageKey: "errors.unauthorized", retryable: false, traceId: TRACE_ID });
    expect(service.create).not.toHaveBeenCalled();
    expect(authorizePayment).not.toHaveBeenCalled();
  });

  it.each(["denied", "policy_error"] as const)(
    "checks action:pay policy after auth and before limiter, body, database or Stripe: %s",
    async (mode) => {
      const service = { create: vi.fn() };
      const limiter = { consume: vi.fn() };
      const authorizePayment = mode === "denied" ? vi.fn(async () => null)
        : vi.fn(async () => { throw new Error("policy backend secret"); });
      const handler = createCheckoutHandler({ getSession: async () => ({ user: { id: "user-1" } }),
        authorizePayment, service, limiter, createTraceId: () => TRACE_ID });
      const response = await handler(new Request("https://app.example/api/v1/checkout-sessions", {
        method: "POST", headers: { "content-type": "application/json" }, body: "not-json",
      }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "PAY_VERIFICATION_REQUIRED",
        messageKey: "errors.payVerificationRequired", retryable: false, traceId: TRACE_ID });
      expect(authorizePayment).toHaveBeenCalledWith("user-1");
      expect(limiter.consume).not.toHaveBeenCalled();
      expect(service.create).not.toHaveBeenCalled();
    },
  );

  it("passes the verified country to checkout instead of trusting the request market", async () => {
    const service = { create: vi.fn(async () => ({ orderId: "order-1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1",
      replayed: false })) };
    const handler = createCheckoutHandler({ getSession: async () => ({ user: { id: "user-1" } }),
      authorizePayment: async () => ({ countryCode: "US" }), service,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, createTraceId: () => TRACE_ID });
    const response = await handler(new Request("https://app.example/api/v1/checkout-sessions", { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "market-12345678" },
      body: JSON.stringify({ planRef: "plus", currency: "USD" }) }));
    expect(response.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith("user-1",
      { planRef: "plus", currency: "USD" }, "market-12345678", "US");
  });

  it("requires idempotency, enforces body size and returns stable non-leaking errors", async () => {
    const handler = createCheckoutHandler({
      getSession: async () => ({ user: { id: "user-1" } }), authorizePayment: async () => ({ countryCode: "US" }),
      service: { create: vi.fn() },
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, createTraceId: () => TRACE_ID,
    });
    const missing = await handler(new Request("https://app.example/api/v1/checkout-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY", traceId: TRACE_ID }));
    const large = await handler(new Request("https://app.example/api/v1/checkout-sessions", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "idem-12345678", "content-length": "20000" }, body: "{}",
    }));
    expect(large.status).toBe(413);
  });

  it("bounds plan pagination and returns only service-safe data", async () => {
    const list = vi.fn(async () => [{ planRef: "plus", nameKey: "plans.plus.name", descriptionKey: "plans.plus.description",
      price: { currency: "USD", unitAmount: 1299, interval: "monthly", intervalCount: 1, taxMode: "exclusive" } }]);
    const handler = createPlansHandler({ list, createTraceId: () => TRACE_ID });
    expect((await handler(new Request("https://app.example/api/v1/plans?country=US&currency=USD&limit=21"))).status).toBe(400);
    const response = await handler(new Request("https://app.example/api/v1/plans?country=US&currency=USD&limit=10"));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(/provider|priceId|cost|risk/iu);
  });

  it("uses a bounded opaque composite plan cursor", async () => {
    const plan = (planRef: string) => ({ planRef, nameKey: `plans.${planRef}.name`, descriptionKey: `plans.${planRef}.description`,
      price: { currency: "USD", unitAmount: 1299, interval: "monthly", intervalCount: 1, taxMode: "exclusive" } });
    const list = vi.fn(async () => [plan("a"), plan("b"), plan("c")]);
    const handler = createPlansHandler({ list, createTraceId: () => TRACE_ID });
    const response = await handler(new Request("https://app.example/api/v1/plans?country=US&currency=USD&limit=2"));
    const body = await response.json() as { plans: unknown[]; nextCursor: string };
    expect(body.plans).toEqual([plan("a"), plan("b")]);
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(body.nextCursor).not.toBe("b");
    const next = await handler(new Request(`https://app.example/api/v1/plans?country=US&currency=USD&limit=2&after=${body.nextCursor}`));
    expect(next.status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ after: "b", limit: 3 }));
    expect((await handler(new Request("https://app.example/api/v1/plans?country=US&currency=USD&after=a"))).status).toBe(400);
    expect((await handler(new Request("https://app.example/api/v1/plans?country=US&currency=USD&after=../secret"))).status).toBe(400);
  });

  it("rejects missing signature and oversized webhook before service invocation", async () => {
    const service = { handle: vi.fn() };
    const handler = createStripeWebhookHandler({ service, createTraceId: () => TRACE_ID });
    const missing = await handler(new Request("https://app.example/api/v1/webhooks/payment/stripe", { method: "POST", body: "{}" }));
    expect(missing.status).toBe(400);
    expect(service.handle).not.toHaveBeenCalled();
    const large = await handler(new Request("https://app.example/api/v1/webhooks/payment/stripe", {
      method: "POST", headers: { "stripe-signature": "signed", "content-length": "300000" }, body: "{}",
    }));
    expect(large.status).toBe(413);
    expect(service.handle).not.toHaveBeenCalled();
  });

  it("returns a safe retryable 503 for verified provider enrichment failure", async () => {
    const service = { handle: vi.fn(async () => { throw new BillingError("PROVIDER_UNAVAILABLE"); }) };
    const handler = createStripeWebhookHandler({ service, createTraceId: () => TRACE_ID });
    const response = await handler(new Request("https://app.example/api/v1/webhooks/payment/stripe", {
      method: "POST", headers: { "stripe-signature": "valid-signature" }, body: "{}",
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "PROVIDER_UNAVAILABLE", messageKey: "errors.serviceUnavailable",
      retryable: true, traceId: TRACE_ID });
  });

  it("enforces the webhook limit on streamed bytes without trusting content-length", async () => {
    const service = { handle: vi.fn() };
    const handler = createStripeWebhookHandler({ service, createTraceId: () => TRACE_ID });
    const response = await handler(new Request("https://app.example/api/v1/webhooks/payment/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: new Uint8Array(262_145),
    }));
    expect(response.status).toBe(413);
    expect(service.handle).not.toHaveBeenCalled();
  });

  it("authenticates subscription self-service before parsing and requires verified ownership for mutation", async () => {
    const service = { get: vi.fn(), update: vi.fn() };
    const unauthenticated = createSubscriptionHandler({ getSession: async () => null, service,
      limiter: { consume: vi.fn() }, createTraceId: () => TRACE_ID });
    const unauthorized = await unauthenticated(new Request("https://app.example/api/v1/me/subscription", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: "not-json",
    }));
    expect(unauthorized.status).toBe(401);
    expect(service.update).not.toHaveBeenCalled();

    const unverified = createSubscriptionHandler({ getSession: async () => ({ user: { id: "user-1", emailVerified: false } }),
      service, limiter: { consume: vi.fn() }, createTraceId: () => TRACE_ID });
    expect((await unverified(new Request("https://app.example/api/v1/me/subscription", { method: "PATCH" }))).status).toBe(403);

    service.get.mockResolvedValueOnce({ planRef: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false });
    service.update.mockResolvedValueOnce({ accepted: true, replayed: false, pending: true });
    const verified = createSubscriptionHandler({ getSession: async () => ({ user: { id: "user-1", emailVerified: true } }),
      service, limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, createTraceId: () => TRACE_ID });
    const get = await verified(new Request("https://app.example/api/v1/me/subscription"));
    expect(await get.json()).toEqual({ subscription: { planRef: "plus", status: "active",
      currentPeriodEnd: null, cancelAtPeriodEnd: false } });
    const patch = await verified(new Request("https://app.example/api/v1/me/subscription", { method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": "manage-12345678" },
      body: JSON.stringify({ action: "cancel_at_period_end" }) }));
    expect(patch.status).toBe(202);
    expect(service.update).toHaveBeenCalledWith("user-1", { action: "cancel_at_period_end" }, "manage-12345678");
  });
});
