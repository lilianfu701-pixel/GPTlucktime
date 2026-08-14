import { createPlansHandler } from "@/modules/billing/billing-route";
import { plansRouteDependencies } from "@/modules/billing/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createPlansHandler(plansRouteDependencies);
