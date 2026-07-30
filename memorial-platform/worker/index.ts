import { closeDb } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { outboxDepth, runOnce } from "@/modules/outbox/runner";
import {
  memorialsDueForPurge,
  purgeMemorial,
} from "@/modules/memorials/deletion";
import { runAnniversaryReminders } from "./jobs/anniversary-reminders";
import { buildRegistry } from "./handlers";

/**
 * The worker process.
 *
 * Two kinds of work run here. Outbox events are drained continuously; the
 * schedules — anniversary reminders, and the purge sweep for memorials whose
 * recovery period has run out — run on their own intervals, because both are
 * about dates rather than about something that just happened.
 *
 * Nothing here does side effects directly. Each handler is a module function
 * that the tests exercise on its own; this file is only the loop, the clock and
 * the shutdown.
 */

/** How long to wait after an empty pass before looking again. */
const IDLE_DELAY_MS = 1_000;

/** How long to wait after a pass that found work. */
const BUSY_DELAY_MS = 50;

const REMINDER_INTERVAL_MS = 5 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const DEPTH_REPORT_INTERVAL_MS = 60 * 1000;

const log = createLogger({ service: "worker" });

let running = true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a scheduled job without letting a failure stop the loop.
 *
 * A reminder sweep that throws must not take the outbox down with it: the two
 * have nothing to do with each other, and a family waiting on a notification
 * should not lose their memorial's search entry as well.
 */
async function safely(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const result = await run();
    log.info(`schedule.${name}`, { result });
  } catch (error) {
    log.error(`schedule.${name}.failed`, { error });
  }
}

async function purgeDue(): Promise<{ purged: number; failed: number }> {
  const due = await memorialsDueForPurge();
  let purged = 0;
  let failed = 0;

  for (const memorialId of due) {
    const result = await purgeMemorial(memorialId, `purge_${memorialId}`);
    if (result.ok) {
      purged += 1;
    } else {
      failed += 1;
      log.warn("purge.refused", { memorialId, reason: result.error });
    }
  }

  return { purged, failed };
}

export async function main(): Promise<void> {
  const handlers = buildRegistry();
  log.info("worker.started", { topics: Object.keys(handlers) });

  let nextReminders = 0;
  let nextPurge = 0;
  let nextDepthReport = 0;

  while (running) {
    const now = Date.now();

    if (now >= nextReminders) {
      nextReminders = now + REMINDER_INTERVAL_MS;
      await safely("anniversary_reminders", () => runAnniversaryReminders());
    }

    if (now >= nextPurge) {
      nextPurge = now + PURGE_INTERVAL_MS;
      await safely("purge_due", purgeDue);
    }

    if (now >= nextDepthReport) {
      nextDepthReport = now + DEPTH_REPORT_INTERVAL_MS;
      await safely("outbox_depth", outboxDepth);
    }

    let summary;
    try {
      summary = await runOnce({
        handlers,
        onEvent: (record) => {
          // One line per event, at the level its outcome deserves: a dead
          // letter is somebody's side effect that will not happen.
          const level = record.outcome === "dead_lettered" ? "error" : "info";
          log[level](`outbox.${record.outcome}`, record);
        },
      });
    } catch (error) {
      // Usually the database being unreachable. Back off rather than spin.
      log.error("outbox.run_failed", { error });
      await sleep(IDLE_DELAY_MS);
      continue;
    }

    await sleep(summary.claimed > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS);
  }

  log.info("worker.stopping");
  await closeDb();
}

/**
 * Stops after the current pass.
 *
 * Not mid-event: an event that has been claimed and dispatched is finished or
 * explicitly failed, never left in a state where nobody can tell which.
 */
export function stop(): void {
  running = false;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith("worker/index.ts");

if (isEntrypoint) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info("worker.signal", { signal });
      stop();
    });
  }

  main().catch((error) => {
    log.error("worker.crashed", { error });
    process.exitCode = 1;
  });
}
