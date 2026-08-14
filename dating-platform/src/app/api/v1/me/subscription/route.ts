import { createSubscriptionHandler } from "@/modules/billing/billing-route";
import { subscriptionRouteDependencies } from "@/modules/billing/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createSubscriptionHandler(subscriptionRouteDependencies);
export const GET = handler;
export const PATCH = handler;
