import { and, asc, count, eq, inArray, isNotNull, isNull, lte, min, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { outboxEvents } from "@/db/schema";

/**
 * What a handler reports back.
 *
 * The distinction that matters is `retryable`. A file that failed a malware
 * scan will fail it again; an upstream that timed out may not. Collapsing the
 * two either buries work that would have succeeded, or spins forever on work
 * that never will.
 */
export type JobResult =
  | { handled: true }
  | { handled: false; reason: string; retryable: boolean };

export type HandlerContext = {
  eventId: string;
  topic: string;
  attempts: number;
};

export type Handler = (
  payload: unknown,
  context: HandlerContext,
) => Promise<JobResult>;

export type HandlerRegistry = Record<string, Handler>;

/**
 * How many times an event is attempted before it is set aside.
 *
 * Five attempts with the curve below spans roughly half an hour, which covers
 * an ordinary restart or failover without letting a genuinely broken event
 * occupy the queue indefinitely.
 */
export const MAX_ATTEMPTS = 5;

/** Retries never spread further apart than this. */
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Bounded so a stack trace cannot smuggle a secret into a table people read. */
export const MAX_ERROR_LENGTH = 300;

const DEFAULT_BATCH = 20;

/**
 * Exponential backoff, capped.
 *
 * The cap is the point: without it, an event that failed during a long outage
 * comes back so far in the future that it is effectively lost, and nobody
 * notices because it is not dead-lettered either.
 */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  // Computed in seconds first so a large exponent cannot overflow to Infinity
  // before the cap is applied.
  if (exponent > 30) {
    return MAX_BACKOFF_MS;
  }
  return Math.min(1000 * 2 ** exponent, MAX_BACKOFF_MS);
}

/** Keeps whatever we write about a failure short and single-line. */
function shortError(value: unknown): string {
  const text =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === "string"
        ? value
        : "UNKNOWN_ERROR";
  return text.replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
}

type ClaimedEvent = {
  id: string;
  topic: string;
  payload: unknown;
  attempts: number;
};

/**
 * Takes a batch of due events, marking them so no other runner takes them too.
 *
 * `skipLocked` is what makes more than one worker safe: a second runner steps
 * over the rows the first is holding rather than blocking behind them. The
 * attempt counter is incremented here, inside the lock, so a worker that dies
 * mid-dispatch has already spent an attempt — otherwise a handler that crashes
 * the process would be retried forever.
 *
 * `availableAt` is pushed forward at the same time. That doubles as a lease: if
 * this process disappears before finalizing, the event comes back on its own
 * after the backoff rather than sitting claimed and invisible.
 *
 * Due-ness is decided by the database's clock, not this process's. Two reasons.
 * `timestamptz` keeps microseconds while a JavaScript `Date` keeps only
 * milliseconds, so a value read back and compared here is rounded down and an
 * event enqueued in the same millisecond as a poll is silently skipped. And a
 * worker whose clock has drifted would otherwise claim events early or never.
 *
 * Only topics this runner can handle are claimed. During a rolling deploy the
 * old workers are still running while the new code has started publishing new
 * topics; a runner that claimed everything would take those events and bury
 * them as unhandleable. Leaving them for a worker that understands them costs
 * nothing, and a topic that no deployed worker handles shows up as a backlog
 * that keeps getting older — see `outboxDepth`.
 */
async function claimBatch(
  topics: string[],
  limit: number,
  now: Date | undefined,
): Promise<ClaimedEvent[]> {
  if (topics.length === 0) {
    return [];
  }

  const due = now ?? sql`now()`;

  return db().transaction(async (tx) => {
    const claimable = await tx
      .select({
        id: outboxEvents.id,
        topic: outboxEvents.topic,
        payload: outboxEvents.payload,
        attempts: outboxEvents.attempts,
      })
      .from(outboxEvents)
      .where(
        and(
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.deadLetteredAt),
          lte(outboxEvents.availableAt, due),
          inArray(outboxEvents.topic, topics),
        ),
      )
      .orderBy(asc(outboxEvents.availableAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed: ClaimedEvent[] = [];
    for (const event of claimable) {
      const attempts = event.attempts + 1;
      await tx
        .update(outboxEvents)
        .set({
          attempts,
          // The lease, in the database's clock domain for the same reason.
          availableAt: sql`now() + make_interval(secs => ${backoffMs(attempts) / 1000})`,
        })
        .where(eq(outboxEvents.id, event.id));
      claimed.push({ ...event, attempts });
    }
    return claimed;
  });
}

async function dispatch(
  handlers: HandlerRegistry,
  event: ClaimedEvent,
): Promise<JobResult> {
  const handler = handlers[event.topic];
  if (!handler) {
    // Unreachable while claiming filters on the registry, kept so a future
    // change to the claim query cannot turn into a silent drop.
    return { handled: false, reason: "NO_HANDLER", retryable: false };
  }

  try {
    return await handler(event.payload, {
      eventId: event.id,
      topic: event.topic,
      attempts: event.attempts,
    });
  } catch (error) {
    // A crash has not proven the work is impossible, only that this try failed.
    return { handled: false, reason: shortError(error), retryable: true };
  }
}

export type RunSummary = {
  claimed: number;
  processed: number;
  retried: number;
  deadLettered: number;
};

/** One pass over the queue. The loop that calls this lives in worker/index.ts. */
export async function runOnce(input: {
  handlers: HandlerRegistry;
  limit?: number;
  now?: Date;
  onEvent?: (record: {
    eventId: string;
    topic: string;
    attempts: number;
    outcome: "processed" | "retried" | "dead_lettered";
    reason?: string;
  }) => void;
}): Promise<RunSummary> {
  const claimed = await claimBatch(
    Object.keys(input.handlers),
    input.limit ?? DEFAULT_BATCH,
    input.now,
  );

  const summary: RunSummary = {
    claimed: claimed.length,
    processed: 0,
    retried: 0,
    deadLettered: 0,
  };

  for (const event of claimed) {
    const result = await dispatch(input.handlers, event);
    const finishedAt = new Date();

    if (result.handled) {
      await db()
        .update(outboxEvents)
        .set({ processedAt: finishedAt, lastError: null })
        .where(eq(outboxEvents.id, event.id));
      summary.processed += 1;
      input.onEvent?.({
        eventId: event.id,
        topic: event.topic,
        attempts: event.attempts,
        outcome: "processed",
      });
      continue;
    }

    const reason = shortError(result.reason);
    const giveUp = !result.retryable || event.attempts >= MAX_ATTEMPTS;

    if (giveUp) {
      await db()
        .update(outboxEvents)
        .set({ deadLetteredAt: finishedAt, lastError: reason })
        .where(eq(outboxEvents.id, event.id));
      summary.deadLettered += 1;
      input.onEvent?.({
        eventId: event.id,
        topic: event.topic,
        attempts: event.attempts,
        outcome: "dead_lettered",
        reason,
      });
      continue;
    }

    await db()
      .update(outboxEvents)
      .set({
        availableAt: sql`now() + make_interval(secs => ${backoffMs(event.attempts) / 1000})`,
        lastError: reason,
      })
      .where(eq(outboxEvents.id, event.id));
    summary.retried += 1;
    input.onEvent?.({
      eventId: event.id,
      topic: event.topic,
      attempts: event.attempts,
      outcome: "retried",
      reason,
    });
  }

  return summary;
}

export type OutboxDepth = {
  pending: number;
  deadLettered: number;
  /** Age of the oldest unprocessed event, or null when the queue is empty. */
  oldestPendingAgeMs: number | null;
  /**
   * Backlog broken down by topic.
   *
   * Some topics are deliberately unhandled while their provider is not yet
   * configured, and their events wait in the queue rather than being destroyed.
   * Naming them is what keeps that an explicit, readable gap instead of a
   * number that quietly climbs.
   */
  pendingByTopic: Record<string, number>;
};

/**
 * The three numbers worth alerting on.
 *
 * Kept apart because they mean different things: a rising backlog says the
 * workers are behind, a rising dead-letter count says they are keeping up and
 * the work itself is broken, and an oldest-pending age that climbs without
 * limit says nothing deployed handles that topic at all.
 */
export async function outboxDepth(): Promise<OutboxDepth> {
  const [pending] = await db()
    .select({ value: count() })
    .from(outboxEvents)
    .where(
      and(isNull(outboxEvents.processedAt), isNull(outboxEvents.deadLetteredAt)),
    );

  const [buried] = await db()
    .select({ value: count() })
    .from(outboxEvents)
    .where(isNotNull(outboxEvents.deadLetteredAt));

  const [oldest] = await db()
    .select({ value: min(outboxEvents.createdAt) })
    .from(outboxEvents)
    .where(
      and(isNull(outboxEvents.processedAt), isNull(outboxEvents.deadLetteredAt)),
    );

  const oldestAt = oldest?.value ? new Date(oldest.value) : null;

  const byTopic = await db()
    .select({ topic: outboxEvents.topic, value: count() })
    .from(outboxEvents)
    .where(
      and(isNull(outboxEvents.processedAt), isNull(outboxEvents.deadLetteredAt)),
    )
    .groupBy(outboxEvents.topic);

  return {
    pending: pending?.value ?? 0,
    deadLettered: buried?.value ?? 0,
    oldestPendingAgeMs: oldestAt ? Date.now() - oldestAt.getTime() : null,
    pendingByTopic: Object.fromEntries(
      byTopic.map((row) => [row.topic, row.value]),
    ),
  };
}

export type DeadLetter = {
  id: string;
  topic: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: Date | null;
};

/** What an operator reads when asking what is stuck. */
export async function deadLetters(
  filter: { topic?: string; limit?: number } = {},
): Promise<DeadLetter[]> {
  const conditions = [isNotNull(outboxEvents.deadLetteredAt)];
  if (filter.topic) {
    conditions.push(eq(outboxEvents.topic, filter.topic));
  }

  return db()
    .select({
      id: outboxEvents.id,
      topic: outboxEvents.topic,
      aggregateId: outboxEvents.aggregateId,
      attempts: outboxEvents.attempts,
      lastError: outboxEvents.lastError,
      deadLetteredAt: outboxEvents.deadLetteredAt,
    })
    .from(outboxEvents)
    .where(and(...conditions))
    .orderBy(asc(outboxEvents.deadLetteredAt))
    .limit(filter.limit ?? 100);
}

/**
 * Puts a dead letter back in the queue.
 *
 * The attempt counter is reset, because a replay is a deliberate decision made
 * after fixing something — not a sixth automatic try. Returns false if the
 * event was not actually dead-lettered, so a mistyped id cannot quietly
 * resurrect an event that is running normally.
 */
export async function replayDeadLetter(eventId: string): Promise<boolean> {
  const updated = await db()
    .update(outboxEvents)
    .set({
      deadLetteredAt: null,
      attempts: 0,
      availableAt: new Date(),
      lastError: null,
    })
    .where(
      and(
        eq(outboxEvents.id, eventId),
        isNotNull(outboxEvents.deadLetteredAt),
        isNull(outboxEvents.processedAt),
      ),
    )
    .returning({ id: outboxEvents.id });

  return updated.length > 0;
}
