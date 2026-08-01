import { NextResponse } from "next/server";
import { cronRequestAuthorized } from "@/lib/cron-auth";
import { createLogger } from "@/lib/logger";
import { outboxDepth, runOnce } from "@/modules/outbox/runner";
import { buildRegistry } from "@/worker/handlers";

export const dynamic = "force-dynamic";
/** Node, not edge: the handlers open a Postgres connection. */
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Drains the outbox.
 *
 * The long-running `worker/index.ts` loop cannot be deployed to a serverless
 * platform, so the same `runOnce` it calls is invoked here on a schedule
 * instead. Nothing about the handlers changes: this file is a different clock,
 * not a different worker.
 *
 * Safe to run concurrently with itself and with a local worker. `runOnce`
 * claims its batch with `SKIP LOCKED`, so an overlapping invocation takes
 * different events rather than the same ones twice.
 */

/** Leaves room to answer before the platform stops the function. */
const TIME_BUDGET_MS = 45_000;

const log = createLogger({ service: "cron.outbox" });

export async function GET(request: Request): Promise<Response> {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const handlers = buildRegistry();

  const totals = { claimed: 0, processed: 0, retried: 0, deadLettered: 0 };
  let passes = 0;

  // Keeps going while there is work, instead of one batch per invocation. A
  // backlog that built up during an outage would otherwise take one scheduler
  // tick per batch to clear.
  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const summary = await runOnce({ handlers });
    passes += 1;

    totals.claimed += summary.claimed;
    totals.processed += summary.processed;
    totals.retried += summary.retried;
    totals.deadLettered += summary.deadLettered;

    if (summary.claimed === 0) {
      break;
    }
  }

  const depth = await outboxDepth();

  // Dead letters are the number worth watching: they are events no retry will
  // fix, and nothing else in the system raises its voice about them.
  log.info("cron.outbox.finished", {
    ...totals,
    passes,
    durationMs: Date.now() - startedAt,
    pending: depth.pending,
    deadLettered: depth.deadLettered,
  });

  return NextResponse.json(
    { ...totals, passes, pending: depth.pending, deadLettered: depth.deadLettered },
    { headers: { "Cache-Control": "no-store" } },
  );
}
