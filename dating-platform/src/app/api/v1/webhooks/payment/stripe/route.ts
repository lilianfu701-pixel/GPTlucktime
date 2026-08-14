import { createStripeWebhookHandler } from "@/modules/billing/billing-route";
import { stripeWebhookRouteDependencies } from "@/modules/billing/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createStripeWebhookHandler(stripeWebhookRouteDependencies);
