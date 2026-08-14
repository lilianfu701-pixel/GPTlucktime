import { createBillingWorkerRoute } from "@/modules/billing/billing-worker-route";
import { runConfiguredBillingWorkers } from "@/modules/billing/runtime";
import { readEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = readEnv(process.env).BILLING_WORKER_CRON_SECRET;
  if (!secret) return Response.json({ code: "BILLING_WORKER_UNAVAILABLE" }, { status: 503 });
  return createBillingWorkerRoute({ secret, run: runConfiguredBillingWorkers })(request);
}
