import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { StripeBillingAdapter } from "@/modules/billing/stripe-adapter";

const secret = "whsec_test_secret_at_least_32_chars";

describe("StripeBillingAdapter", () => {
  it("uses the 2026-07-29 invoice payments relation instead of a removed top-level payment_intent", async () => {
    const stripe = new Stripe("sk_test_placeholder");
    const payload = JSON.stringify({
      id: "evt_1", object: "event", type: "invoice.paid", created: 1775995200,
      data: { object: { id: "in_1", object: "invoice", customer: "cus_1", subscription: "sub_1",
        payments: { object: "list", has_more: false, url: "/v1/invoice_payments?invoice=in_1", data: [
          { id: "inpay_1", object: "invoice_payment", status: "paid", amount_paid: 1299,
            payment: { type: "payment_intent", payment_intent: "pi_1" } },
        ] }, amount_paid: 1299, currency: "usd", period_start: 1775000000,
        period_end: 1777600000, metadata: { userId: "00000000-0000-4000-8000-000000000001",
          orderId: "00000000-0000-4000-8000-000000000002" } } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1775995200 });
    const adapter = new StripeBillingAdapter({ stripe, webhookSecret: secret, nowSeconds: () => 1775995200 });
    await expect(adapter.verifyAndNormalize(new TextEncoder().encode(payload), signature)).resolves.toEqual(expect.objectContaining({
      id: "evt_1", type: "invoice.paid", providerInvoiceId: "in_1", providerSubscriptionId: "sub_1",
      providerInvoicePaymentId: "inpay_1", providerPaymentId: "pi_1", providerChargeId: null,
      amount: 1299, currency: "USD",
    }));
  });

  it("retrieves a paid InvoicePayment when the invoice event omits its includable payments relation", async () => {
    const invoicePayments = { list: vi.fn(async () => ({ data: [{ id: "inpay_2", status: "paid",
      payment: { type: "charge", charge: "ch_2" } }], has_more: false })) };
    const stripe = new Stripe("sk_test_placeholder");
    Object.defineProperty(stripe, "invoicePayments", { value: invoicePayments });
    const payload = JSON.stringify({ id: "evt_lookup", object: "event", type: "invoice.paid", created: 1775995200,
      data: { object: { id: "in_2", object: "invoice", customer: "cus_1", subscription: "sub_1",
        amount_paid: 1299, currency: "usd" } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1775995200 });
    const adapter = new StripeBillingAdapter({ stripe, webhookSecret: secret, nowSeconds: () => 1775995200 });
    await expect(adapter.verifyAndNormalize(new TextEncoder().encode(payload), signature)).resolves.toEqual(
      expect.objectContaining({ providerInvoicePaymentId: "inpay_2", providerChargeId: "ch_2", providerPaymentId: null }),
    );
    expect(invoicePayments.list).toHaveBeenCalledWith({ invoice: "in_2", status: "paid", limit: 100,
      expand: ["data.payment.charge", "data.payment.payment_intent"] });
  });

  it("paginates and normalizes every paid InvoicePayment relation beyond ten entries", async () => {
    const links = Array.from({ length: 12 }, (_, index) => ({ id: `inpay_${index + 1}`, status: "paid",
      payment: index % 2 === 0
        ? { type: "payment_intent", payment_intent: `pi_${index + 1}` }
        : { type: "charge", charge: `ch_${index + 1}` } }));
    const list = vi.fn(async (input: { starting_after?: string }) => input.starting_after
      ? { data: links.slice(10), has_more: false }
      : { data: links.slice(0, 10), has_more: true });
    const stripe = new Stripe("sk_test_placeholder");
    Object.defineProperty(stripe, "invoicePayments", { value: { list } });
    const payload = JSON.stringify({ id: "evt_many_links", object: "event", type: "invoice.paid", created: 1775995200,
      data: { object: { id: "in_many", object: "invoice", customer: "cus_1", subscription: "sub_1",
        amount_paid: 1299, currency: "usd" } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1775995200 });
    const adapter = new StripeBillingAdapter({ stripe, webhookSecret: secret, nowSeconds: () => 1775995200 });
    const normalized = await adapter.verifyAndNormalize(new TextEncoder().encode(payload), signature);
    expect(normalized.paymentLinks).toHaveLength(12);
    expect(normalized.paymentLinks).toEqual(expect.arrayContaining([
      { providerInvoicePaymentId: "inpay_1", providerPaymentId: "pi_1", providerChargeId: null },
      { providerInvoicePaymentId: "inpay_12", providerPaymentId: null, providerChargeId: "ch_12" },
    ]));
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ starting_after: "inpay_10", limit: 100 }));
  });

  it("acknowledges a verified invoice with no payment linkage as fail-closed manual review", async () => {
    const invoicePayments = { list: vi.fn(async () => ({ data: [], has_more: false })) };
    const stripe = new Stripe("sk_test_placeholder");
    Object.defineProperty(stripe, "invoicePayments", { value: invoicePayments });
    const payload = JSON.stringify({ id: "evt_missing", object: "event", type: "invoice.paid", created: 1775995200,
      data: { object: { id: "in_missing", object: "invoice", amount_paid: 1299, currency: "usd" } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1775995200 });
    const adapter = new StripeBillingAdapter({ stripe, webhookSecret: secret, nowSeconds: () => 1775995200 });
    await expect(adapter.verifyAndNormalize(new TextEncoder().encode(payload), signature)).resolves.toEqual(
      expect.objectContaining({ type: "unknown", providerInvoiceId: "in_missing",
        reviewReason: "INVOICE_PAYMENT_LINK_MISSING:in_missing" }),
    );
  });

  it("surfaces a transient InvoicePayment enrichment failure for provider retry instead of manual review", async () => {
    const invoicePayments = { list: vi.fn(async () => { throw new Error("ETIMEDOUT provider secret"); }) };
    const stripe = new Stripe("sk_test_placeholder");
    Object.defineProperty(stripe, "invoicePayments", { value: invoicePayments });
    const payload = JSON.stringify({ id: "evt_timeout", object: "event", type: "invoice.paid", created: 1775995200,
      data: { object: { id: "in_timeout", object: "invoice", amount_paid: 1299, currency: "usd" } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1775995200 });
    const adapter = new StripeBillingAdapter({ stripe, webhookSecret: secret, nowSeconds: () => 1775995200 });
    await expect(adapter.verifyAndNormalize(new TextEncoder().encode(payload), signature))
      .rejects.toThrow("PROVIDER_ENRICHMENT_RETRYABLE");
  });

  it.each([
    ["incomplete", "past_due"], ["paused", "past_due"], ["unpaid", "expired"],
    ["incomplete_expired", "expired"],
  ] as const)("maps non-entitled Stripe status %s to %s", async (providerStatus, expected) => {
    const stripe = new Stripe("sk_test_placeholder");
    const payload = JSON.stringify({ id: `evt_${providerStatus}`, object: "event",
      type: "customer.subscription.updated", created: 1775995200,
      data: { object: { id: "sub_1", object: "subscription", status: providerStatus, customer: "cus_1" } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1775995200 });
    const adapter = new StripeBillingAdapter({ stripe, webhookSecret: secret, nowSeconds: () => 1775995200 });
    await expect(adapter.verifyAndNormalize(new TextEncoder().encode(payload), signature)).resolves.toEqual(
      expect.objectContaining({ type: "subscription.updated", subscriptionStatus: expected }),
    );
  });

  it("fails an unknown Stripe subscription status closed for entitlement and marks it for review", async () => {
    const stripe = new Stripe("sk_test_placeholder");
    const payload = JSON.stringify({ id: "evt_future", object: "event", type: "customer.subscription.updated",
      created: 1775995200, data: { object: { id: "sub_1", object: "subscription", status: "future_activeish" } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1775995200 });
    const adapter = new StripeBillingAdapter({ stripe, webhookSecret: secret, nowSeconds: () => 1775995200 });
    await expect(adapter.verifyAndNormalize(new TextEncoder().encode(payload), signature)).resolves.toEqual(
      expect.objectContaining({ type: "unknown", subscriptionStatus: "expired",
        reviewReason: "UNKNOWN_SUBSCRIPTION_STATUS:future_activeish" }),
    );
  });

  it("rejects a missing, bad or stale signature", async () => {
    const stripe = new Stripe("sk_test_placeholder");
    const payload = JSON.stringify({ id: "evt_bad", object: "event", type: "unknown", created: 1,
      data: { object: { id: "obj_1", object: "unknown" } } });
    const stale = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1 });
    const adapter = new StripeBillingAdapter({ stripe, webhookSecret: secret, nowSeconds: () => 1_000 });
    await expect(adapter.verifyAndNormalize(new TextEncoder().encode(payload), "bad")).rejects.toThrow();
    await expect(adapter.verifyAndNormalize(new TextEncoder().encode(payload), stale)).rejects.toThrow();
  });

  it("creates Stripe checkout with server values and the order idempotency key", async () => {
    const create = vi.fn(async (params: unknown, options: unknown) => {
      void params;
      void options;
      return { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" };
    });
    const adapter = new StripeBillingAdapter({
      stripe: { checkout: { sessions: { create } } } as never,
      webhookSecret: secret,
    });
    const result = await adapter.createCheckoutSession({ providerPriceId: "price_1",
      successUrl: "https://app.example/billing/return?status=success", cancelUrl: "https://app.example/billing/return?status=cancel",
      metadata: { orderId: "order-1", userId: "user-1", priceId: "price-row-1", planVersion: "2" },
      idempotencyKey: "checkout:order-1" });
    expect(result).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }], allow_promotion_codes: false,
      metadata: expect.objectContaining({ orderId: "order-1" }) }),
    { idempotencyKey: "checkout:order-1" });
    expect(create.mock.calls[0]![0]).not.toHaveProperty("amount");
  });

  it("updates cancellation intent with a provider idempotency key", async () => {
    const update = vi.fn(async () => ({ id: "sub_1" }));
    const adapter = new StripeBillingAdapter({ stripe: { subscriptions: { update } } as never, webhookSecret: secret });
    await adapter.setCancelAtPeriodEnd({ providerSubscriptionId: "sub_1", cancelAtPeriodEnd: true,
      idempotencyKey: "subscription-intent:intent-1" });
    expect(update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true },
      { idempotencyKey: "subscription-intent:intent-1" });
  });

  it("lists only paid invoices in the bounded reconciliation ledger page", async () => {
    const stripe = {
      subscriptions: { list: vi.fn(async () => ({ data: [{ id: "sub_1", status: "active" }], has_more: false })) },
      invoices: { list: vi.fn(async () => ({ data: [
        { id: "in_paid", status: "paid", amount_paid: 1299 },
        { id: "in_draft", status: "draft", amount_paid: 0 },
        { id: "in_open", status: "open", amount_paid: 0 },
        { id: "in_uncollectible", status: "uncollectible", amount_paid: 0 },
        { id: "in_void", status: "void", amount_paid: 0 },
      ], has_more: false })) },
      refunds: { list: vi.fn(async () => ({ data: [{ id: "re_1", amount: 100 }], has_more: false })) },
      disputes: { list: vi.fn(async () => ({ data: [{ id: "dp_1", status: "needs_response", amount: 1299 }], has_more: false })) },
    };
    const adapter = new StripeBillingAdapter({ stripe: stripe as never, webhookSecret: secret });
    const page = await adapter.listLedgerPage({ cursor: null, limit: 25 });
    expect(page).toEqual({ subscriptions: [{ id: "sub_1", status: "active" }],
      invoices: [{ id: "in_paid", status: "paid", amount: 1299 }], refunds: [{ id: "re_1", amount: 100 }],
      disputes: [{ id: "dp_1", status: "needs_response", amount: 1299 }], nextCursor: null });
    expect(stripe.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, status: "all" }));
    expect(stripe.invoices.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, status: "paid" }));
  });

  it("does not restart completed collections while another reconciliation collection paginates", async () => {
    const subscriptions = { list: vi.fn(async () => ({ data: [{ id: "sub_done" }], has_more: false })) };
    const invoices = { list: vi.fn()
      .mockResolvedValueOnce({ data: [{ id: "in_1" }], has_more: true })
      .mockResolvedValueOnce({ data: [{ id: "in_2" }], has_more: false }) };
    const empty = { list: vi.fn(async () => ({ data: [], has_more: false })) };
    const adapter = new StripeBillingAdapter({ stripe: { subscriptions, invoices, refunds: empty, disputes: empty } as never,
      webhookSecret: secret });
    const first = await adapter.listLedgerPage({ cursor: null, limit: 25 });
    expect(first.nextCursor).not.toBeNull();
    const second = await adapter.listLedgerPage({ cursor: first.nextCursor, limit: 25 });
    expect(second.nextCursor).toBeNull();
    expect(subscriptions.list).toHaveBeenCalledOnce();
    expect(invoices.list).toHaveBeenCalledTimes(2);
  });
});
