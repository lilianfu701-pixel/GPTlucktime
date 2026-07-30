import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { anniversaryReminders, outboxEvents } from "@/db/schema";
import { flags } from "@/lib/feature-flags";
import { nextAnniversaryFor } from "@/modules/religion/calendar";
import { registerBuiltInCalendars } from "@/modules/religion/calendars";

registerBuiltInCalendars();

export type ReminderRunSummary = {
  considered: number;
  enqueued: number;
  /** Calendars with no adapter, or dates too imprecise to name a day. */
  skipped: number;
  disabled: boolean;
};

/** How far ahead a run looks. The job is expected to run more often than this. */
const LOOKAHEAD_MS = 60 * 60 * 1000;

/**
 * Sends the reminders that have come due, and works out the following one.
 *
 * The order matters. The notification is written to the outbox and the next
 * occurrence advanced in the same transaction, so the job cannot move a reminder
 * forward without having queued anything: a family would silently miss the day,
 * and nothing would show that it had happened.
 *
 * A reminder whose calendar has no adapter is left where it is, with the reason
 * recorded. It is not advanced by a guessed interval — doc 05 section 8 rules
 * that out, and a wrong date on an anniversary is worse than no reminder.
 */
export async function runAnniversaryReminders(input: {
  now?: Date;
} = {}): Promise<ReminderRunSummary> {
  const now = input.now ?? new Date();

  if (!flags().anniversaryNotificationsEnabled) {
    // Phase one keeps this closed. Doc 09 section 9.
    return { considered: 0, enqueued: 0, skipped: 0, disabled: true };
  }

  const due = await db()
    .select()
    .from(anniversaryReminders)
    .where(
      and(
        eq(anniversaryReminders.enabled, true),
        isNotNull(anniversaryReminders.nextOccurrenceAt),
        lte(
          anniversaryReminders.nextOccurrenceAt,
          new Date(now.getTime() + LOOKAHEAD_MS),
        ),
      ),
    );

  let enqueued = 0;
  let skipped = 0;

  for (const reminder of due) {
    const following = nextAnniversaryFor({
      date: {
        calendarId: reminder.calendarId,
        year: reminder.sourceYear,
        month: reminder.sourceMonth,
        day: reminder.sourceDay,
        precision: "day",
      },
      // Computed from the occurrence being sent, not from the clock, so a late
      // run still lands on the following year rather than skipping one.
      after: reminder.nextOccurrenceAt ?? now,
      timeZone: reminder.timeZone,
    });

    if (!following.ok) {
      // Record why and leave the occurrence untouched, so the reminder is not
      // lost and the failure is visible to an operator.
      await db()
        .update(anniversaryReminders)
        .set({ lastError: following.error })
        .where(eq(anniversaryReminders.id, reminder.id));
      skipped += 1;
      continue;
    }

    await db().transaction(async (tx) => {
      await tx.insert(outboxEvents).values({
        topic: "notification.send",
        aggregateId: reminder.memorialId,
        payload: {
          kind: "memorial.anniversary",
          reminderId: reminder.id,
          memorialId: reminder.memorialId,
          occasion: reminder.kind,
          occurrenceAt: reminder.nextOccurrenceAt?.toISOString() ?? null,
        },
      });

      await tx
        .update(anniversaryReminders)
        .set({
          lastEnqueuedAt: now,
          nextOccurrenceAt: following.value.occurrenceAt,
          adapterVersion: following.value.adapterVersion,
          lastError: null,
        })
        .where(eq(anniversaryReminders.id, reminder.id));
    });

    enqueued += 1;
  }

  return { considered: due.length, enqueued, skipped, disabled: false };
}
