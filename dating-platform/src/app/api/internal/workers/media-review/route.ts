import { createMediaWorkerRoute } from "@/modules/profiles/media-worker-route";
import { readEnv } from "@/shared/env";
import { runConfiguredMediaReviewWorker } from "@/workers/media-review-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = readEnv(process.env).MEDIA_WORKER_CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "MEDIA_WORKER_UNAVAILABLE" }, { status: 503 });
  }
  return createMediaWorkerRoute({ secret, run: runConfiguredMediaReviewWorker })(request);
}
