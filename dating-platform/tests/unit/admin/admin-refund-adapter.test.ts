import { describe, expect, it, vi } from "vitest";

import { StripeBillingAdapter } from "@/modules/billing/stripe-adapter";

describe("manual refund provider adapter", () => {
  it("submits a provider refund with a stable idempotency key without creating a local refund fact", async () => {
    const create = vi.fn(async () => ({ id: "re_123", status: "pending" }));
    const stripe = {
      refunds: { create }, checkout: { sessions: { create: vi.fn() } }, subscriptions: { update: vi.fn() },
      webhooks: { constructEvent: vi.fn() }, invoicePayments: { list: vi.fn() },
    };
    const adapter = new StripeBillingAdapter({ stripe: stripe as never, webhookSecret: "w".repeat(32) });
    await expect(adapter.createRefund({ providerPaymentId: "pi_123", amount: 500,
      idempotencyKey: "admin-refund-0000000000000001" })).resolves.toEqual({ providerRefundId: "re_123" });
    expect(create).toHaveBeenCalledWith({ payment_intent: "pi_123", amount: 500 },
      { idempotencyKey: "admin-refund-0000000000000001" });
  });
});
