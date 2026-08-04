import { after } from "next/server";
import { createLogger } from "@/lib/logger";
import { runOnce } from "./runner";
import { buildRegistry } from "@/worker/handlers";

const log = createLogger({ service: "outbox.after" });

/**
 * Drains the outbox once the response has gone out.
 *
 * The events that decide whether a memorial can be found — created, published,
 * privacy changed — used to wait for whatever scheduler happened to be
 * running. On a serverless host that is at best minutes and, on this plan's
 * own cron, up to a day. A family publishes a memorial and tells relatives to
 * look for it; the search finding nothing for a day is the whole product
 * failing at the moment it is needed.
 *
 * So the request that caused the event drains it itself. The scheduled run
 * stays as the retry path for anything that failed here, not as the only way
 * work ever gets done.
 *
 * Runs after the response is flushed, so the caller never waits on it. Bounded
 * to a small batch: this is the tail of someone's request, not a worker, and
 * it must not turn one family's publish into a sweep of everyone's backlog.
 */
export function drainOutboxAfterResponse(correlationId: string): void {
  after(async () => {
    try {
      const summary = await runOnce({ handlers: buildRegistry(), limit: 10 });
      if (summary.claimed > 0) {
        log.info("outbox.drained_inline", { ...summary, correlationId });
      }
    } catch (error) {
      // Swallowed on purpose. The response is already sent, and the scheduled
      // drain will pick these up again — an error here must not surface as a
      // failure of an action that already succeeded.
      log.error("outbox.inline_drain_failed", { error, correlationId });
    }
  });
}
