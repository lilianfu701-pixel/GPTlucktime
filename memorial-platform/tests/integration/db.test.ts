import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import { auditLogs, outboxEvents } from "@/db/schema";

/**
 * Every row this suite writes carries one of these identifiers, and cleanup
 * deletes by them alone. A shared test database must never be truncated
 * wholesale: another suite may be mid-assertion on its own rows.
 */
let correlationId: string;
let aggregateId: string;

beforeAll(() => {
  // Fail loudly rather than silently exercising a developer's dev database.
  const url = process.env.DATABASE_URL ?? "";
  expect(url).toMatch(/^postgres(ql)?:\/\//);
  expect(url).toContain("_test");
});

afterEach(async () => {
  await db().delete(auditLogs).where(eq(auditLogs.correlationId, correlationId));
  await db().delete(outboxEvents).where(eq(outboxEvents.aggregateId, aggregateId));
});

afterAll(async () => {
  await closeDb();
});

describe("transactional outbox", () => {
  beforeAll(() => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();
  });

  it("commits the audit entry and the outbox event together", async () => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();

    await db().transaction(async (tx) => {
      await tx.insert(auditLogs).values({
        action: "memorial.created",
        resourceType: "memorial",
        resourceId: aggregateId,
        correlationId,
      });

      await tx.insert(outboxEvents).values({
        topic: "memorial.created",
        aggregateId,
        payload: { memorialId: aggregateId, correlationId },
      });
    });

    const audits = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, correlationId));
    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, aggregateId));

    expect(audits).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(audits[0]?.action).toBe("memorial.created");
    expect(events[0]?.topic).toBe("memorial.created");
  });

  it("persists neither when the transaction fails after the first insert", async () => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();

    let visibleInsideTransaction = 0;

    await expect(
      db().transaction(async (tx) => {
        await tx.insert(auditLogs).values({
          action: "memorial.privacy_changed",
          resourceType: "memorial",
          resourceId: aggregateId,
          correlationId,
        });

        // Proves the insert really executed. Without this, a silently failing
        // insert would produce the same empty result below as a working
        // rollback, and the test would pass for the wrong reason.
        const inside = await tx
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.correlationId, correlationId));
        visibleInsideTransaction = inside.length;

        // Stands in for any later failure in the same unit of work: a
        // constraint violation, a permission check, a lost connection.
        throw new Error("domain failure after the audit write");
      }),
    ).rejects.toThrow("domain failure after the audit write");

    expect(visibleInsideTransaction).toBe(1);

    const audits = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, correlationId));

    expect(audits).toHaveLength(0);
  });

  it("does not emit an outbox event when the business write is rolled back", async () => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();

    await expect(
      db().transaction(async (tx) => {
        await tx.insert(outboxEvents).values({
          topic: "search.index",
          aggregateId,
          payload: { memorialId: aggregateId },
        });

        await tx.insert(auditLogs).values({
          action: "memorial.created",
          resourceType: "memorial",
          resourceId: aggregateId,
          correlationId,
        });

        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, aggregateId));

    // A published event for work that never happened is the failure mode the
    // outbox pattern exists to prevent.
    expect(events).toHaveLength(0);
  });
});

describe("outbox event defaults", () => {
  it("starts unprocessed, unattempted and immediately available", async () => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();
    const before = new Date();

    await db().insert(outboxEvents).values({
      topic: "notification.send",
      aggregateId,
      payload: { to: "family" },
    });

    const [event] = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, aggregateId));

    expect(event).toBeDefined();
    expect(event?.attempts).toBe(0);
    expect(event?.processedAt).toBeNull();
    expect(event?.availableAt).toBeInstanceOf(Date);
    expect(event?.availableAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it("stores timestamps as timezone-aware instants", async () => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();
    const before = Date.now();

    await db().insert(outboxEvents).values({
      topic: "media.process",
      aggregateId,
      payload: {},
    });

    const [event] = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, aggregateId));

    const createdAt = event?.createdAt;
    expect(createdAt).toBeInstanceOf(Date);
    // Round-tripping through the driver must not shift the instant. A column
    // declared without a time zone would drift by the server's offset.
    expect(Math.abs((createdAt?.getTime() ?? 0) - before)).toBeLessThan(60_000);
  });

  it("keeps the payload readable as structured JSON", async () => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();

    await db().insert(outboxEvents).values({
      topic: "export.requested",
      aggregateId,
      payload: { memorialId: aggregateId, locale: "zh-CN", nested: { depth: 2 } },
    });

    const [event] = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, aggregateId));

    expect(event?.payload).toEqual({
      memorialId: aggregateId,
      locale: "zh-CN",
      nested: { depth: 2 },
    });
  });
});

describe("audit entries", () => {
  it("records the old and new value of a state change", async () => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();

    await db().insert(auditLogs).values({
      action: "memorial.privacy_changed",
      resourceType: "memorial",
      resourceId: aggregateId,
      oldValue: { visibility: "public" },
      newValue: { visibility: "invite_only" },
      reason: "family request",
      correlationId,
    });

    const [entry] = await db()
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.correlationId, correlationId),
          eq(auditLogs.resourceType, "memorial"),
        ),
      );

    expect(entry?.oldValue).toEqual({ visibility: "public" });
    expect(entry?.newValue).toEqual({ visibility: "invite_only" });
    expect(entry?.reason).toBe("family request");
  });

  it("accepts a platform action that has no acting user", async () => {
    correlationId = `test_${randomUUID()}`;
    aggregateId = randomUUID();

    await db().insert(auditLogs).values({
      action: "ritual_version.retired",
      resourceType: "ritual_version",
      resourceId: aggregateId,
      correlationId,
    });

    const [entry] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, correlationId));

    expect(entry?.actorUserId).toBeNull();
  });
});
