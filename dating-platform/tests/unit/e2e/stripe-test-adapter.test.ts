import { describe, expect, it } from "vitest";

import { E2eStripeProvider, makeE2eStripeFixture } from "@/modules/e2e/stripe-test-adapter";

describe("explicit local Stripe test adapter", () => {
  it("creates only a loopback guarded checkout URL", async () => {
    const provider = new E2eStripeProvider("http://127.0.0.1:3200", "x".repeat(32));
    const session = await provider.createCheckoutSession({ providerPriceId: "price_e2e", successUrl: "unused",
      cancelUrl: "unused", metadata: { orderId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000002", priceId: "00000000-0000-4000-8000-000000000003",
        planVersion: "1" }, idempotencyKey: "checkout:test" });
    const url = new URL(session.url);
    expect(url.origin).toBe("http://127.0.0.1:3200");
    expect(url.pathname).toBe("/api/e2e/stripe-checkout");
    expect(url.searchParams.get("token")).toBe("x".repeat(32));
  });

  it.each(["activate", "refund"] as const)("generates deterministic livemode:false %s fixtures", (kind) => {
    const payload = makeE2eStripeFixture({ kind, orderId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002", amount: 1299, currency: "USD", created: 1_787_620_000 });
    const event = JSON.parse(payload) as Record<string, unknown>;
    expect(event).toMatchObject({ id: `evt_e2e_${kind}_00000000000040008000000000000001`, livemode: false,
      created: 1_787_620_000 });
    expect(payload).not.toContain("sk_live");
  });
});
