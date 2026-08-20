import { createAdminApprovalWorkerRoute } from "@/modules/admin/admin-worker-route";
import { runConfiguredAdminApprovalWorker } from "@/modules/admin/runtime";
import { readEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = readEnv(process.env).ADMIN_WORKER_CRON_SECRET;
  if (!secret) return Response.json({ code: "ADMIN_WORKER_UNAVAILABLE" }, {
    status: 503, headers: { "cache-control": "private, no-store" },
  });
  return createAdminApprovalWorkerRoute({ secret, run: runConfiguredAdminApprovalWorker })(request);
}
