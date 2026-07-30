import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  anniversaryReminders,
  auditLogs,
  deceasedPeople,
  memorials,
  outboxEvents,
  users,
} from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { createMemorial } from "@/modules/memorials/service";
import { runAnniversaryReminders } from "@/worker/jobs/anniversary-reminders";
import type { Actor } from "@/modules/permissions/types";

const createdUserIds: string[] = [];

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
});

afterEach(async () => {
  delete process.env.ANNIVERSARY_NOTIFICATIONS_ENABLED;
  resetEnvCache();

  const userIds = createdUserIds.splice(0);
  if (userIds.length === 0) return;

  const owned = await db()
    .select({ id: memorials.id, personId: memorials.deceasedPersonId })
    .from(memorials)
    .where(inArray(memorials.ownerUserId, userIds));
  const memorialIds = owned.map((row) => row.id);

  if (memorialIds.length > 0) {
    await db()
      .delete(anniversaryReminders)
      .where(inArray(anniversaryReminders.memorialId, memorialIds));
    await db().delete(auditLogs).where(inArray(auditLogs.resourceId, memorialIds));
    await db()
      .delete(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, memorialIds));
    await db().delete(memorials).where(inArray(memorials.id, memorialIds));
    await db()
      .delete(deceasedPeople)
      .where(inArray(deceasedPeople.id, owned.map((row) => row.personId)));
  }

  await db().delete(users).where(inArray(users.id, userIds));
});

afterAll(async () => {
  await closeDb();
});

async function makeActor(): Promise<Actor> {
  const [row] = await db()
    .insert(users)
    .values({ displayName: `Person ${randomUUID().slice(0, 8)}` })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no row");
  createdUserIds.push(row.id);
  return { userId: row.id, platformRole: "user" };
}

async function makeMemorial(): Promise<string> {
  const owner = await makeActor();
  const result = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");
  return result.value.memorialId;
}

async function makeReminder(input: {
  memorialId: string;
  calendarId?: string;
  month?: number;
  day?: number;
  timeZone?: string;
  nextOccurrenceAt: Date | null;
  enabled?: boolean;
}): Promise<string> {
  const [row] = await db()
    .insert(anniversaryReminders)
    .values({
      memorialId: input.memorialId,
      kind: "death_anniversary",
      calendarId: input.calendarId ?? "gregorian",
      adapterVersion: "1.0.0",
      sourceYear: 2020,
      sourceMonth: input.month ?? 3,
      sourceDay: input.day ?? 15,
      timeZone: input.timeZone ?? "UTC",
      nextOccurrenceAt: input.nextOccurrenceAt,
      enabled: input.enabled ?? true,
    })
    .returning({ id: anniversaryReminders.id });
  if (!row) throw new Error("reminder insert returned no row");
  return row.id;
}

/**
 * Notification events for a memorial.
 *
 * Filtered by topic on purpose: creating a memorial already writes a
 * `memorial.created` event against the same aggregate, so counting every event
 * would measure the fixture rather than the job.
 */
async function notificationEvents(memorialId: string) {
  return db()
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, memorialId),
        eq(outboxEvents.topic, "notification.send"),
      ),
    );
}

function enableFeature(): void {
  process.env.ANNIVERSARY_NOTIFICATIONS_ENABLED = "true";
  resetEnvCache();
}

describe("the feature switch", () => {
  it("sends nothing while anniversary notifications are off", async () => {
    // Phase one keeps this closed. Doc 09 section 9.
    const memorialId = await makeMemorial();
    await makeReminder({
      memorialId,
      nextOccurrenceAt: new Date("2026-03-15T00:00:00Z"),
    });

    const summary = await runAnniversaryReminders({
      now: new Date("2026-03-15T00:00:00Z"),
    });

    expect(summary.disabled).toBe(true);
    expect(summary.enqueued).toBe(0);

    const events = await notificationEvents(memorialId);
    expect(events).toHaveLength(0);
  });
});

describe("what comes due", () => {
  it("queues a notification for an occurrence that has arrived", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    const reminderId = await makeReminder({
      memorialId,
      nextOccurrenceAt: new Date("2026-03-15T00:00:00Z"),
    });

    const summary = await runAnniversaryReminders({
      now: new Date("2026-03-15T00:00:00Z"),
    });

    expect(summary.enqueued).toBe(1);

    const events = await notificationEvents(memorialId);
    expect(events).toHaveLength(1);
    expect(events[0]?.topic).toBe("notification.send");
    expect(events[0]?.processedAt).toBeNull();
    expect(events[0]?.payload).toMatchObject({
      kind: "memorial.anniversary",
      reminderId,
    });
  });

  it("leaves an occurrence still in the future alone", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    await makeReminder({
      memorialId,
      nextOccurrenceAt: new Date("2026-06-01T00:00:00Z"),
    });

    const summary = await runAnniversaryReminders({
      now: new Date("2026-03-15T00:00:00Z"),
    });

    expect(summary.considered).toBe(0);
    expect(summary.enqueued).toBe(0);
  });

  it("ignores a reminder the family switched off", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    await makeReminder({
      memorialId,
      nextOccurrenceAt: new Date("2026-03-15T00:00:00Z"),
      enabled: false,
    });

    expect(
      (await runAnniversaryReminders({ now: new Date("2026-03-15T00:00:00Z") }))
        .enqueued,
    ).toBe(0);
  });
});

describe("advancing to the following year", () => {
  it("moves the occurrence forward by a real year, not by 365 days", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    // 2028 is a leap year, so a naive 365-day step from 2027-03-15 would land on
    // 2028-03-14.
    const reminderId = await makeReminder({
      memorialId,
      nextOccurrenceAt: new Date("2027-03-15T00:00:00Z"),
    });

    await runAnniversaryReminders({ now: new Date("2027-03-15T00:00:00Z") });

    const [row] = await db()
      .select()
      .from(anniversaryReminders)
      .where(eq(anniversaryReminders.id, reminderId));

    expect(row?.nextOccurrenceAt?.toISOString()).toBe("2028-03-15T00:00:00.000Z");
  });

  it("advances from the occurrence being sent, not from the clock", async () => {
    // A run that happens days late must not skip a year.
    enableFeature();
    const memorialId = await makeMemorial();
    const reminderId = await makeReminder({
      memorialId,
      nextOccurrenceAt: new Date("2026-03-15T00:00:00Z"),
    });

    await runAnniversaryReminders({ now: new Date("2026-03-20T00:00:00Z") });

    const [row] = await db()
      .select()
      .from(anniversaryReminders)
      .where(eq(anniversaryReminders.id, reminderId));

    expect(row?.nextOccurrenceAt?.toISOString()).toBe("2027-03-15T00:00:00.000Z");
  });

  it("keeps a 29 February reminder in February", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    const reminderId = await makeReminder({
      memorialId,
      month: 2,
      day: 29,
      nextOccurrenceAt: new Date("2028-02-29T00:00:00Z"),
    });

    await runAnniversaryReminders({ now: new Date("2028-02-29T00:00:00Z") });

    const [row] = await db()
      .select()
      .from(anniversaryReminders)
      .where(eq(anniversaryReminders.id, reminderId));

    // 2029 is a common year: the last day of February, never 1 March.
    expect(row?.nextOccurrenceAt?.toISOString()).toBe("2029-02-28T00:00:00.000Z");
  });

  it("computes the following occurrence in the memorial's time zone", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    const reminderId = await makeReminder({
      memorialId,
      timeZone: "Asia/Tokyo",
      nextOccurrenceAt: new Date("2026-03-14T15:00:00Z"),
    });

    await runAnniversaryReminders({ now: new Date("2026-03-14T15:00:00Z") });

    const [row] = await db()
      .select()
      .from(anniversaryReminders)
      .where(eq(anniversaryReminders.id, reminderId));

    // Tokyo is UTC+9, so local midnight on 15 March 2027 is 15:00 UTC on the 14th.
    expect(row?.nextOccurrenceAt?.toISOString()).toBe("2027-03-14T15:00:00.000Z");
  });

  it("records the adapter version that produced the date", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    const reminderId = await makeReminder({
      memorialId,
      nextOccurrenceAt: new Date("2026-03-15T00:00:00Z"),
    });

    await runAnniversaryReminders({ now: new Date("2026-03-15T00:00:00Z") });

    const [row] = await db()
      .select()
      .from(anniversaryReminders)
      .where(eq(anniversaryReminders.id, reminderId));

    // A date told to a family has to be explainable if it later changes.
    expect(row?.adapterVersion).toBe("1.0.0");
    expect(row?.lastEnqueuedAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBeNull();
  });
});

describe("a calendar with no adapter", () => {
  it("is not advanced by a guessed interval", async () => {
    // Doc 05 section 8. A wrong date on an anniversary is worse than none, so
    // the reminder stays where it is with the reason recorded.
    enableFeature();
    const memorialId = await makeMemorial();
    const due = new Date("2026-03-15T00:00:00Z");
    const reminderId = await makeReminder({
      memorialId,
      calendarId: "hijri",
      nextOccurrenceAt: due,
    });

    const summary = await runAnniversaryReminders({ now: due });

    expect(summary.skipped).toBe(1);
    expect(summary.enqueued).toBe(0);

    const [row] = await db()
      .select()
      .from(anniversaryReminders)
      .where(eq(anniversaryReminders.id, reminderId));

    expect(row?.nextOccurrenceAt?.toISOString()).toBe(due.toISOString());
    expect(row?.lastError).toBe("CALENDAR_NOT_CONFIGURED");
    expect(row?.lastEnqueuedAt).toBeNull();
  });

  it("queues nothing for it", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    await makeReminder({
      memorialId,
      calendarId: "hebrew",
      nextOccurrenceAt: new Date("2026-03-15T00:00:00Z"),
    });

    await runAnniversaryReminders({ now: new Date("2026-03-15T00:00:00Z") });

    const events = await notificationEvents(memorialId);
    expect(events).toHaveLength(0);
  });

  it("does not block other reminders in the same run", async () => {
    enableFeature();
    const unsupportedMemorial = await makeMemorial();
    const supportedMemorial = await makeMemorial();
    const due = new Date("2026-03-15T00:00:00Z");

    await makeReminder({
      memorialId: unsupportedMemorial,
      calendarId: "hijri",
      nextOccurrenceAt: due,
    });
    await makeReminder({ memorialId: supportedMemorial, nextOccurrenceAt: due });

    const summary = await runAnniversaryReminders({ now: due });

    expect(summary.skipped).toBe(1);
    expect(summary.enqueued).toBe(1);
  });
});

describe("the notification and the advance are one transaction", () => {
  it("never advances a reminder without having queued anything", async () => {
    // The failure this prevents: a family silently misses the day, and nothing
    // in the record shows that it happened.
    enableFeature();
    const memorialId = await makeMemorial();
    const due = new Date("2026-03-15T00:00:00Z");
    const reminderId = await makeReminder({ memorialId, nextOccurrenceAt: due });

    await runAnniversaryReminders({ now: due });

    const [row] = await db()
      .select()
      .from(anniversaryReminders)
      .where(eq(anniversaryReminders.id, reminderId));
    const events = await notificationEvents(memorialId);

    const advanced = row?.nextOccurrenceAt?.toISOString() !== due.toISOString();
    expect(advanced).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("does not queue the same occurrence twice across two runs", async () => {
    enableFeature();
    const memorialId = await makeMemorial();
    const due = new Date("2026-03-15T00:00:00Z");
    await makeReminder({ memorialId, nextOccurrenceAt: due });

    await runAnniversaryReminders({ now: due });
    const second = await runAnniversaryReminders({ now: due });

    // The first run moved the occurrence a year out, so the second finds nothing.
    expect(second.enqueued).toBe(0);

    const events = await notificationEvents(memorialId);
    expect(events).toHaveLength(1);
  });
});
