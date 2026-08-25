import type { CheckoutProvider } from "@/modules/billing/checkout-service";
import type { SubscriptionProvider } from "@/modules/billing/subscription-service";

const fixtureSuffix = (orderId: string) => orderId.replaceAll("-", "");

export class E2eStripeProvider implements CheckoutProvider, SubscriptionProvider {
  constructor(private readonly appUrl: string, private readonly controlToken: string) {
    const url = new URL(appUrl);
    if (url.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)
      || controlToken.length < 32) throw new Error("E2E_RUNTIME_REJECTED");
  }

  async createCheckoutSession(input: Parameters<CheckoutProvider["createCheckoutSession"]>[0]) {
    const url = new URL("/api/e2e/stripe-checkout", this.appUrl);
    url.searchParams.set("orderId", input.metadata.orderId);
    url.searchParams.set("token", this.controlToken);
    return { id: `cs_e2e_${fixtureSuffix(input.metadata.orderId)}`, url: url.toString() };
  }

  async setCancelAtPeriodEnd(input: Parameters<SubscriptionProvider["setCancelAtPeriodEnd"]>[0]): Promise<void> {
    void input;
    return undefined;
  }
}

export function makeE2eStripeFixture(input: { kind: "activate" | "refund"; orderId: string; userId: string;
  amount: number; currency: string; created: number }) {
  const suffix = fixtureSuffix(input.orderId);
  const common = { object: "event", api_version: "2026-07-29.dahlia", created: input.created,
    livemode: false, pending_webhooks: 0 };
  const metadata = { orderId: input.orderId, userId: input.userId };
  if (input.kind === "activate") return JSON.stringify({ ...common, id: `evt_e2e_activate_${suffix}`,
    type: "invoice.paid", data: { object: { id: `in_e2e_${suffix}`, object: "invoice",
      customer: `cus_e2e_${suffix}`, subscription: `sub_e2e_${suffix}`,
      amount_paid: input.amount, currency: input.currency.toLowerCase(),
      period_start: input.created, period_end: input.created + 2_592_000, metadata,
      payments: { object: "list", has_more: false, data: [{ id: `inpay_e2e_${suffix}`,
        object: "invoice_payment", status: "paid", amount_paid: input.amount,
        payment: { type: "payment_intent", payment_intent: `pi_e2e_${suffix}` } }] } } } });
  return JSON.stringify({ ...common, id: `evt_e2e_refund_${suffix}`, type: "charge.refund.created",
    data: { object: { id: `re_e2e_${suffix}`, object: "refund", amount: input.amount,
      currency: input.currency.toLowerCase(), payment_intent: `pi_e2e_${suffix}`,
      charge: `ch_e2e_${suffix}`, metadata } } });
}
