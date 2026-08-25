import Stripe from "stripe";

import { assertTestModeResource, inspectStripeTestConfig } from "./stripe-test-verifier-lib";

const failures = inspectStripeTestConfig(process.env);
if (failures.length > 0) {
  console.error("Stripe test-mode verification preflight failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const price = await stripe.prices.retrieve(process.env.STRIPE_TEST_PRICE_ID!);
assertTestModeResource(price, "price");
if (!price.active || price.type !== "recurring") throw new Error("Stripe acceptance price must be active and recurring");
const endpoint = new URL(process.env.STRIPE_TEST_WEBHOOK_URL!);
const returnOrigin = `${endpoint.protocol}//${endpoint.host}`;
const session = await stripe.checkout.sessions.create({
  mode: "subscription",
  line_items: [{ price: price.id, quantity: 1 }],
  success_url: `${returnOrigin}/stripe-acceptance/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${returnOrigin}/stripe-acceptance/cancel`,
  expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  metadata: { acceptance_gate: "external_test_mode" },
});
assertTestModeResource(session, "Checkout Session");
await stripe.checkout.sessions.expire(session.id);
const fixture = JSON.stringify({
  id: `evt_acceptance_${Date.now()}`, object: "event", api_version: null,
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: `cus_acceptance_${Date.now()}`, object: "customer", livemode: false } },
  livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type: "customer.created",
});
const signature = stripe.webhooks.generateTestHeaderString({ payload: fixture, secret: process.env.STRIPE_WEBHOOK_SECRET! });
const response = await fetch(endpoint, { method: "POST",
  headers: { "content-type": "application/json", "stripe-signature": signature }, body: fixture,
  signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`Stripe webhook acceptance endpoint returned HTTP ${response.status}`);
console.log(JSON.stringify({ verified: true, provider: "Stripe test mode", priceId: price.id,
  checkoutCreatedAndExpired: true, signedWebhookAccepted: true }, null, 2));
