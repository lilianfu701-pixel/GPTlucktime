import { createCheckoutHandler } from "@/modules/billing/billing-route";
import { checkoutRouteDependencies } from "@/modules/billing/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createCheckoutHandler(checkoutRouteDependencies);
