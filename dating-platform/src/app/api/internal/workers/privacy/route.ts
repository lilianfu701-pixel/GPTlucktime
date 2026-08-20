import { randomUUID, timingSafeEqual } from "node:crypto";

import { runConfiguredPrivacyWorkers } from "@/modules/profiles/privacy-runtime";
import { readEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const failure = (code: string, messageKey: string, status: number, retryable: boolean, traceId: string) =>
  Response.json({ code, messageKey, retryable, traceId }, { status,
    headers: { "cache-control": "private, no-store", "x-trace-id": traceId } });

const handler = async (request: Request) => {
  const traceId = randomUUID();
  const secret = readEnv(process.env).PRIVACY_WORKER_CRON_SECRET;
  if (!secret) return failure("PRIVACY_WORKER_UNAVAILABLE", "errors.serviceUnavailable", 503, true, traceId);
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return failure("UNAUTHORIZED", "errors.unauthorized", 401, false, traceId);
  }
  if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED", "errors.methodNotAllowed", 405, false, traceId);
  try { return Response.json(await runConfiguredPrivacyWorkers(), {
    headers: { "cache-control": "private, no-store", "x-trace-id": traceId },
  }); } catch { return failure("PRIVACY_WORKER_FAILED", "errors.internal", 500, true, traceId); }
};

export const POST = handler;
export const GET = handler;
export const DELETE = handler;
export const PATCH = handler;
export const PUT = handler;
