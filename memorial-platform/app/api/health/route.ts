/**
 * Liveness.
 *
 * Answers as long as the process can serve a request. It deliberately touches
 * nothing else: a liveness probe that checks the database restarts every web
 * process during a database blip, which turns a recoverable incident into an
 * outage. Readiness is the check that cares whether dependencies are up, and it
 * lives at /api/health/ready.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
