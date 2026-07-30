import { checkReadiness } from "@/modules/observability/health";

/**
 * Readiness.
 *
 * Reachable without signing in, because a load balancer cannot sign in, so the
 * body says only what a load balancer needs. The migration counts are included
 * because they are two integers about our own build, and knowing the schema is
 * behind is exactly what someone diagnosing a bad deploy needs to see first.
 * Nothing about the connection, the host or the failure reason appears here.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const readiness = await checkReadiness();
  const ok = readiness.status === "ready";

  return Response.json(readiness, {
    // 503 rather than 200-with-a-flag: a probe that has to read the body to
    // learn the answer is a probe that will be configured wrong.
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
