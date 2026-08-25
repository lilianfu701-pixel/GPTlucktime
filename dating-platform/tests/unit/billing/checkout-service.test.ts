import { describe, expect, it, vi } from "vitest";

import { BillingError, CheckoutService, selectPublicPlans, type CheckoutProvider } from "@/modules/billing/checkout-service";

const now = new Date("2026-08-12T12:00:00.000Z");
const price = {
  id: "00000000-0000-4000-8000-000000000101",
  planRef: "plus",
  planVersion: 3,
  planNameKey: "plans.plus.name",
  planDescriptionKey: "plans.plus.description",
  providerPriceId: "price_private_123",
  countryCode: "US",
  currency: "USD",
  unitAmount: 1299,
  interval: "monthly" as const,
  intervalCount: 1,
  taxMode: "exclusive" as const,
  active: true,
  effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
  expiresAt: null,
};

describe("server-authoritative billing catalog", () => {
  it("returns only active public fields and never provider or internal pricing fields", () => {
    const result = selectPublicPlans([price], { countryCode: "US", currency: "USD", now });
    expect(result).toEqual([{ planRef: "plus", nameKey: "plans.plus.name", descriptionKey: "plans.plus.description",
      price: { currency: "USD", unitAmount: 1299, interval: "monthly", intervalCount: 1, taxMode: "exclusive" } }]);
    expect(JSON.stringify(result)).not.toMatch(/provider|priceId|cost|risk|version/iu);
  });

  it("uses exact country and currency and rejects inactive or expired prices", () => {
    expect(selectPublicPlans([{ ...price, active: false }], { countryCode: "US", currency: "USD", now })).toEqual([]);
    expect(selectPublicPlans([{ ...price, expiresAt: now }], { countryCode: "US", currency: "USD", now })).toEqual([]);
    expect(selectPublicPlans([price], { countryCode: "CA", currency: "USD", now })).toEqual([]);
    expect(selectPublicPlans([price], { countryCode: "US", currency: "EUR", now })).toEqual([]);
  });
});

describe("CheckoutService", () => {
  const make = (overrides: Record<string, unknown> = {}) => {
    const order = { id: "00000000-0000-4000-8000-000000000201", userId: "user-1", price,
      providerSessionId: null as string | null, checkoutUrl: null as string | null };
    const store = {
      selectPrice: vi.fn(async () => price),
      createOrGetPendingOrder: vi.fn(async () => ({ order, created: true })),
      attachProviderSession: vi.fn(async (_id: string, session: { id: string; url: string }) => {
        order.providerSessionId = session.id; order.checkoutUrl = session.url;
      }),
      recordProviderFailure: vi.fn(async () => undefined),
      assertCustomerOwnership: vi.fn(async () => undefined),
      ...overrides,
    };
    const provider = { createCheckoutSession: vi.fn<CheckoutProvider["createCheckoutSession"]>(async () =>
      ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" })) };
    return { service: new CheckoutService({ store, provider, appUrl: "https://app.example.test", clock: () => now }),
      store, provider, order };
  };

  it("rejects amount, currency and provider-price spoofing before catalog access", async () => {
    const { service, store } = make();
    await expect(service.create("user-1", { planRef: "plus", countryCode: "US", currency: "USD", amount: 1 }, "idem-1", "US"))
      .rejects.toMatchObject({ code: "INVALID_CHECKOUT" });
    await expect(service.create("user-1", { planRef: "plus", countryCode: "US", currency: "USD", stripePriceId: "price_evil" }, "idem-2", "US"))
      .rejects.toMatchObject({ code: "INVALID_CHECKOUT" });
    await expect(service.create("user-1", { planRef: "plus", countryCode: "US" }, "idem-country", "US"))
      .rejects.toMatchObject({ code: "INVALID_CHECKOUT" });
    expect(store.selectPrice).not.toHaveBeenCalled();
  });

  it("creates checkout with only a plan reference and the server-selected currency", async () => {
    const { service, store, provider } = make();
    await expect(service.create("user-1", { planRef: "plus" }, "plan-only-1234", "US"))
      .resolves.toMatchObject({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(store.selectPrice).toHaveBeenCalledWith({ planRef: "plus", countryCode: "US", now });
    expect(provider.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ providerPriceId: "price_private_123" }));
  });

  it("uses the verified country and rejects a client currency that differs from its server offer", async () => {
    const { service, store, provider } = make();
    await expect(service.create("user-1", { planRef: "plus", currency: "INR" },
      "market-12345678", "US")).rejects.toMatchObject({ code: "PRICE_NOT_AVAILABLE" });
    expect(store.selectPrice).toHaveBeenCalledWith({ planRef: "plus", countryCode: "US", now });
    expect(provider.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("persists a pending order before Stripe and binds authoritative metadata and allowlisted URLs", async () => {
    const calls: string[] = [];
    const { service, store, provider } = make({
      createOrGetPendingOrder: vi.fn(async () => { calls.push("order-committed"); return ({
        order: { id: "00000000-0000-4000-8000-000000000201", userId: "user-1", price,
          providerSessionId: null, checkoutUrl: null }, created: true,
      }); }),
    });
    provider.createCheckoutSession.mockImplementation(async () => { calls.push("provider-called"); return {
      id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1",
    }; });
    const result = await service.create("user-1", { planRef: "plus", currency: "USD" }, "idem-1234", "US");
    expect(calls).toEqual(["order-committed", "provider-called"]);
    expect(provider.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      providerPriceId: "price_private_123",
      successUrl: "https://app.example.test/billing/return?status=success",
      cancelUrl: "https://app.example.test/billing/return?status=cancel",
      metadata: { orderId: expect.any(String), userId: "user-1", priceId: price.id, planVersion: "3" },
      idempotencyKey: expect.stringMatching(/^checkout:/u),
    }));
    expect(result).toEqual({ orderId: expect.any(String), checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1", replayed: false });
    expect(store.attachProviderSession).toHaveBeenCalledOnce();
  });

  it("reuses one order/session and safely retries a provider failure", async () => {
    const { service, store, provider, order } = make();
    provider.createCheckoutSession.mockRejectedValueOnce(new Error("secret provider detail"));
    await expect(service.create("user-1", { planRef: "plus", currency: "USD" }, "idem-1234", "US"))
      .rejects.toEqual(new BillingError("PROVIDER_UNAVAILABLE"));
    expect(store.recordProviderFailure).toHaveBeenCalledOnce();
    await service.create("user-1", { planRef: "plus", currency: "USD" }, "idem-1234", "US");
    expect(provider.createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(new Set(provider.createCheckoutSession.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(1);
    order.providerSessionId = "cs_1"; order.checkoutUrl = "https://checkout.stripe.com/c/pay/cs_1";
    store.createOrGetPendingOrder.mockResolvedValueOnce({ order, created: false });
    const replay = await service.create("user-1", { planRef: "plus", currency: "USD" }, "idem-1234", "US");
    expect(replay.replayed).toBe(true);
    expect(provider.createCheckoutSession).toHaveBeenCalledTimes(2);
  });

  it("uses only the server-owned Stripe customer mapping", async () => {
    const { service, provider } = make({ assertCustomerOwnership: vi.fn(async () => "cus_owned") });
    await service.create("user-1", { planRef: "plus", currency: "USD" }, "idem-owned", "US");
    expect(provider.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ providerCustomerId: "cus_owned" }));
  });

  it("rejects a lookalike checkout host", async () => {
    const { service, provider } = make();
    provider.createCheckoutSession.mockResolvedValueOnce({ id: "cs_evil", url: "https://evilstripe.com/cs_evil" });
    await expect(service.create("user-1", { planRef: "plus", currency: "USD" }, "idem-evil", "US"))
      .rejects.toEqual(new BillingError("PROVIDER_UNAVAILABLE"));
  });

  it("allows an explicitly injected guarded checkout URL policy", async () => {
    const { store, provider } = make();
    const localUrl = "http://127.0.0.1:3200/api/e2e/stripe-checkout?orderId=order-1";
    provider.createCheckoutSession.mockResolvedValueOnce({ id: "cs_test_local", url: localUrl });
    const service = new CheckoutService({ store, provider, appUrl: "http://127.0.0.1:3200", clock: () => now,
      checkoutUrlPolicy: (url: URL) => url.origin === "http://127.0.0.1:3200"
        && url.pathname === "/api/e2e/stripe-checkout" } as never);
    await expect(service.create("user-1", { planRef: "plus", currency: "USD" }, "idem-local-1234", "US"))
      .resolves.toMatchObject({ checkoutUrl: localUrl });
  });
});
