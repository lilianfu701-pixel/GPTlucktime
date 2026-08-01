import { NextResponse } from "next/server";
import { cronRequestAuthorized } from "@/lib/cron-auth";
import { createLogger } from "@/lib/logger";
import {
  memorialsDueForPurge,
  purgeMemorial,
} from "@/modules/memorials/deletion";
import { runAnniversaryReminders } from "@/worker/jobs/anniversary-reminders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The date-driven work.
 *
 * Separate from the outbox drain because it answers to a different clock. The
 * outbox reacts to something that just happened and wants to run every few
 * minutes; these two are about dates passing, and once a day is what they mean.
 *
 * That split also fits where each is scheduled from: this one runs on Vercel's
 * own cron, whose free tier allows exactly one invocation a day.
 */

const log = createLogger({ service: "cron.daily" });

/**
 * Deletes memorials whose recovery window has closed.
 *
 * A refusal is logged and counted rather than thrown. One memorial that cannot
 * be purged — a governance hold, most likely — must not stop the sweep from
 * reaching the rest, because every one left behind is a family's deletion
 * request that has not been honoured.
 */
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

export async function GET(request: Request): Promise<Response> {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Independent of each other, and reported separately. A reminder sweep that
  // throws must not take the purge with it: a family waiting on a deletion has
  // a stronger claim than a notification that can go out tomorrow.
  const [reminders, purge] = await Promise.allSettled([
    runAnniversaryReminders(),
    purgeDue(),
  ]);

  const body = {
    reminders:
      reminders.status === "fulfilled"
        ? reminders.value
        : { failed: true as const },
    purge: purge.status === "fulfilled" ? purge.value : { failed: true as const },
  };

  if (reminders.status === "rejected") {
    log.error("cron.daily.reminders_failed", { error: reminders.reason });
  }
  if (purge.status === "rejected") {
    log.error("cron.daily.purge_failed", { error: purge.reason });
  }

  log.info("cron.daily.finished", body);

  // 200 even when one half failed: the scheduler retrying the whole thing would
  // re-run the half that worked. The log and the body carry the failure.
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
