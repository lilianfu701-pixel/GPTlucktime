import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import { outboxEvents } from "@/db/schema";
import {
  MAX_ATTEMPTS,
  backoffMs,
  deadLetters,
  outboxDepth,
  replayDeadLetter,
  runOnce,
} from "@/modules/outbox/runner";
import type { HandlerRegistry } from "@/modules/outbox/runner";

const createdEventIds: string[] = [];

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
});

/**
 * Makes sure the pool has spare connections ready.
 *
 * Without this the two runners in the concurrency test do not overlap: the
 * first pays for establishing a connection and has committed before the second
 * begins, so the test passes even with the row lock removed.
 */
async function warmPool(): Promise<void> {
  await Promise.all([1, 2, 3, 4].map(() => db().execute(sql`select 1`)));
}

afterEach(async () => {
  const ids = createdEventIds.splice(0);
  if (ids.length > 0) {
    await db().delete(outboxEvents).where(inArray(outboxEvents.id, ids));
  }
});

afterAll(async () => {
  await closeDb();
});

async function enqueue(input: {
  topic: string;
  payload?: unknown;
  availableAt?: Date;
  attempts?: number;
}): Promise<string> {
  const [row] = await db()
    .insert(outboxEvents)
    .values({
      topic: input.topic,
      aggregateId: randomUUID(),
      payload: (input.payload ?? {}) as Record<string, unknown>,
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    })
    .returning({ id: outboxEvents.id });
  if (!row) throw new Error("outbox insert returned no row");
  createdEventIds.push(row.id);
  return row.id;
}

async function read(id: string) {
  const [row] = await db()
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.id, id));
  if (!row) throw new Error("event disappeared");
  return row;
}

/** A registry scoped to one test, so runs cannot pick up each other's events. */
function registry(
  topic: string,
  handler: HandlerRegistry[string],
): HandlerRegistry {
  return { [topic]: handler };
}

describe("claiming", () => {
  it("processes an event that is due", async () => {
    const topic = `test.due.${randomUUID()}`;
    const id = await enqueue({ topic });
    let seen: unknown = null;

    const summary = await runOnce({
      handlers: registry(topic, async (payload) => {
        seen = payload;
        return { handled: true };
      }),
    });

    expect(summary.processed).toBe(1);
    expect(seen).toEqual({});
    expect((await read(id)).processedAt).not.toBeNull();
  });

  it("leaves an event alone until it is due", async () => {
    const topic = `test.future.${randomUUID()}`;
    const id = await enqueue({
      topic,
      availableAt: new Date(Date.now() + 60_000),
    });

    const summary = await runOnce({
      handlers: registry(topic, async () => ({ handled: true })),
    });

    expect(summary.processed).toBe(0);
    expect((await read(id)).processedAt).toBeNull();
  });

  it("never runs an event that was already processed", async () => {
    const topic = `test.once.${randomUUID()}`;
    const id = await enqueue({ topic });
    let calls = 0;
    const handlers = registry(topic, async () => {
      calls += 1;
      return { handled: true };
    });

    await runOnce({ handlers });
    await runOnce({ handlers });

    expect(calls).toBe(1);
    expect((await read(id)).processedAt).not.toBeNull();
  });

  it("does not hand the same event to two runners at once", async () => {
    // Both runners are inside their claim transaction before either commits.
    // Without `for update skip locked` both select the same row and both
    // dispatch it, and a family gets the same notification twice. Verified by
    // removing the lock: this fails on every run, and passes on every run with
    // it. `warmPool` is what makes that true — without it the two transactions
    // serialize and the assertion proves nothing.
    const topic = `test.race.${randomUUID()}`;
    await warmPool();
    await enqueue({ topic });
    let calls = 0;
    const handlers = registry(topic, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { handled: true };
    });

    const [a, b] = await Promise.all([
      runOnce({ handlers }),
      runOnce({ handlers }),
    ]);

    expect(calls).toBe(1);
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.processed + b.processed).toBe(1);
  });
});

describe("retrying", () => {
  it("backs off exponentially and stays bounded", () => {
    const delays = [1, 2, 3, 4, 5].map((n) => backoffMs(n));

    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
    // An unbounded curve turns a long outage into an event that is effectively
    // never retried again.
    expect(backoffMs(50)).toBeLessThanOrEqual(backoffMs(51));
    expect(backoffMs(1000)).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("reschedules a retryable failure instead of losing it", async () => {
    const topic = `test.retry.${randomUUID()}`;
    const id = await enqueue({ topic });
    const before = Date.now();

    const summary = await runOnce({
      handlers: registry(topic, async () => ({
        handled: false,
        reason: "UPSTREAM_TIMEOUT",
        retryable: true,
      })),
    });

    const row = await read(id);
    expect(summary.retried).toBe(1);
    expect(row.processedAt).toBeNull();
    expect(row.deadLetteredAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.availableAt.getTime()).toBeGreaterThan(before);
    expect(row.lastError).toContain("UPSTREAM_TIMEOUT");
  });

  it("treats a thrown error as retryable", async () => {
    // A handler that crashes has not proven the work is impossible, only that
    // this attempt failed.
    const topic = `test.throw.${randomUUID()}`;
    const id = await enqueue({ topic });

    const summary = await runOnce({
      handlers: registry(topic, async () => {
        throw new Error("connection reset");
      }),
    });

    const row = await read(id);
    expect(summary.retried).toBe(1);
    expect(row.attempts).toBe(1);
    expect(row.deadLetteredAt).toBeNull();
  });

  it("gives up after the attempt limit", async () => {
    const topic = `test.exhausted.${randomUUID()}`;
    const id = await enqueue({ topic, attempts: MAX_ATTEMPTS - 1 });

    const summary = await runOnce({
      handlers: registry(topic, async () => ({
        handled: false,
        reason: "STILL_BROKEN",
        retryable: true,
      })),
    });

    const row = await read(id);
    expect(summary.deadLettered).toBe(1);
    expect(row.deadLetteredAt).not.toBeNull();
    expect(row.attempts).toBe(MAX_ATTEMPTS);
  });
});

describe("giving up early", () => {
  it("dead-letters a permanent failure without burning retries", async () => {
    // Re-scanning the same executable reaches the same conclusion. Retrying it
    // four more times delays every other event behind it for nothing.
    const topic = `test.permanent.${randomUUID()}`;
    const id = await enqueue({ topic });

    const summary = await runOnce({
      handlers: registry(topic, async () => ({
        handled: false,
        reason: "INVALID_PAYLOAD",
        retryable: false,
      })),
    });

    const row = await read(id);
    expect(summary.deadLettered).toBe(1);
    expect(row.deadLetteredAt).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("INVALID_PAYLOAD");
  });

  it("leaves a topic it does not understand for a worker that does", async () => {
    // During a rolling deploy the previous workers are still running while the
    // new code has started publishing. A runner that claimed everything would
    // take those events and bury them, so a deploy would silently destroy every
    // notification published during the rollout.
    const topic = `test.orphan.${randomUUID()}`;
    const id = await enqueue({ topic });

    const summary = await runOnce({ handlers: {} });

    const row = await read(id);
    expect(summary.claimed).toBe(0);
    expect(row.attempts).toBe(0);
    expect(row.deadLetteredAt).toBeNull();
    expect(row.processedAt).toBeNull();
  });

  it("does not let another runner's topics be claimed either", async () => {
    const mine = `test.mine.${randomUUID()}`;
    const theirs = `test.theirs.${randomUUID()}`;
    const theirId = await enqueue({ topic: theirs });
    await enqueue({ topic: mine });

    const summary = await runOnce({
      handlers: registry(mine, async () => ({ handled: true })),
    });

    expect(summary.claimed).toBe(1);
    expect((await read(theirId)).attempts).toBe(0);
  });

  it("never claims a dead-lettered event again", async () => {
    const topic = `test.buried.${randomUUID()}`;
    await enqueue({ topic });
    let calls = 0;
    const handlers = registry(topic, async () => {
      calls += 1;
      return { handled: false, reason: "NOPE", retryable: false };
    });

    await runOnce({ handlers });
    await runOnce({ handlers });

    expect(calls).toBe(1);
  });
});

describe("what an operator can see and do", () => {
  it("reports the backlog and the buried separately", async () => {
    const topic = `test.depth.${randomUUID()}`;
    const before = await outboxDepth();
    await enqueue({ topic });
    await enqueue({ topic });
    await runOnce({
      handlers: registry(topic, async () => ({
        handled: false,
        reason: "BROKEN",
        retryable: false,
      })),
    });
    await enqueue({ topic });

    const after = await outboxDepth();
    expect(after.deadLettered - before.deadLettered).toBe(2);
    expect(after.pending - before.pending).toBe(1);
  });

  it("ages the backlog, so a topic nobody handles becomes visible", async () => {
    // This is the only signal that an unclaimed topic exists at all: the count
    // alone looks like an ordinary queue, but one that never drains gets older
    // without limit.
    await enqueue({ topic: `test.aging.${randomUUID()}` });

    const depth = await outboxDepth();
    expect(depth.oldestPendingAgeMs).not.toBeNull();
    expect(depth.oldestPendingAgeMs!).toBeGreaterThanOrEqual(0);
  });

  it("lists dead letters with the reason attached", async () => {
    const topic = `test.list.${randomUUID()}`;
    const id = await enqueue({ topic });
    await runOnce({
      handlers: registry(topic, async () => ({
        handled: false,
        reason: "SCANNER_REJECTED",
        retryable: false,
      })),
    });

    const rows = await deadLetters({ topic });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.lastError).toContain("SCANNER_REJECTED");
  });

  it("replays a dead letter once the cause is fixed", async () => {
    const topic = `test.replay.${randomUUID()}`;
    const id = await enqueue({ topic });
    let attempt = 0;
    const handlers = registry(topic, async () => {
      attempt += 1;
      return attempt === 1
        ? { handled: false, reason: "MISCONFIGURED", retryable: false }
        : { handled: true };
    });

    await runOnce({ handlers });
    expect((await read(id)).deadLetteredAt).not.toBeNull();

    const replayed = await replayDeadLetter(id);
    expect(replayed).toBe(true);

    await runOnce({ handlers });
    const row = await read(id);
    expect(row.processedAt).not.toBeNull();
    expect(row.deadLetteredAt).toBeNull();
  });

  it("refuses to replay an event that was never dead-lettered", async () => {
    const id = await enqueue({ topic: `test.noreplay.${randomUUID()}` });
    expect(await replayDeadLetter(id)).toBe(false);
  });
});

describe("what gets written down", () => {
  it("bounds the recorded error", async () => {
    // A stack trace can carry a connection string. Operators read this column
    // casually, and it is copied into tickets.
    const topic = `test.long.${randomUUID()}`;
    const id = await enqueue({ topic });

    await runOnce({
      handlers: registry(topic, async () => {
        throw new Error("x".repeat(5000));
      }),
    });

    const row = await read(id);
    expect(row.lastError!.length).toBeLessThanOrEqual(300);
  });

  it("does not copy the payload into the error", async () => {
    const topic = `test.payload.${randomUUID()}`;
    const id = await enqueue({
      topic,
      payload: { inviteToken: "secret-token-value" },
    });

    await runOnce({
      handlers: registry(topic, async () => {
        throw new Error("failed");
      }),
    });

    expect((await read(id)).lastError).not.toContain("secret-token-value");
  });
});
