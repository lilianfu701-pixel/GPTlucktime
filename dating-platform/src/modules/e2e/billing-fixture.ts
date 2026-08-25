import Stripe from "stripe";
import { eq } from "drizzle-orm";

import { billingOrders } from "@/db/schema";
import { db } from "@/infrastructure/db/client";
import { BillingEntitlementRefreshWorker, DrizzleEntitlementRefreshStore } from "@/workers/billing-entitlement-worker";

import { requireE2eRuntime } from "./e2e-guard";
import { makeE2eStripeFixture } from "./stripe-test-adapter";

export async function replayE2eStripeFixture(orderId: string, kind: "activate" | "refund") {
  requireE2eRuntime(process.env);
  const [order] = await db.select({ id: billingOrders.id, userId: billingOrders.userId,
    amount: billingOrders.amount, currency: billingOrders.currency }).from(billingOrders)
    .where(eq(billingOrders.id, orderId)).limit(1);
  if (!order) throw new Error("E2E_BILLING_ORDER_NOT_FOUND");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || secret.length < 16) throw new Error("E2E_STRIPE_SECRET_REJECTED");
  const created = Math.floor(Date.now() / 1_000);
  const payload = makeE2eStripeFixture({ kind, orderId: order.id, userId: order.userId,
    amount: order.amount, currency: order.currency, created });
  const stripe = new Stripe("sk_test_local_adapter_no_live_connection");
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: created });
  const response = await fetch(new URL("/api/v1/webhooks/payment/stripe", process.env.APP_URL), {
    method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: payload,
  });
  if (!response.ok) throw new Error(`E2E_STRIPE_WEBHOOK_REJECTED_${response.status}`);
  const worker = new BillingEntitlementRefreshWorker({ store: new DrizzleEntitlementRefreshStore(db),
    invalidate: async () => undefined });
  await worker.drain(10);
  return { acknowledged: true, fixture: kind, livemode: false, provider: "local-stripe-test-adapter" };
}
