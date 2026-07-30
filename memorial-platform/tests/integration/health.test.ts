import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  deceasedPeople,
  memorials,
  outboxEvents,
  searchDocuments,
  users,
} from "@/db/schema";
import { runOnce } from "@/modules/outbox/runner";
import { createMemorial } from "@/modules/memorials/service";
import type { Actor } from "@/modules/permissions/types";
import {
  checkReadiness,
  expectedMigrationCount,
} from "@/modules/observability/health";
import { buildRegistry } from "@/worker/handlers";

const createdUserIds: string[] = [];

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
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

afterEach(async () => {
  const userIds = createdUserIds.splice(0);
  if (userIds.length === 0) return;

  const owned = await db()
    .select({ id: memorials.id, personId: memorials.deceasedPersonId })
    .from(memorials)
    .where(inArray(memorials.ownerUserId, userIds));
  const memorialIds = owned.map((row) => row.id);

  if (memorialIds.length > 0) {
    await db()
      .delete(searchDocuments)
      .where(inArray(searchDocuments.memorialId, memorialIds));
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

function journalWith(entries: number): string {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  const path = join(dir, "_journal.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: "7",
      entries: Array.from({ length: entries }, (_, i) => ({ idx: i })),
    }),
  );
  return path;
}

describe("readiness", () => {
  it("reports ready against a migrated database", async () => {
    const readiness = await checkReadiness();

    expect(readiness.status).toBe("ready");
    expect(readiness.migrations!.applied).toBeGreaterThan(0);
    expect(readiness.migrations!.applied).toBeGreaterThanOrEqual(
      readiness.migrations!.expected,
    );
  });

  it("counts the migrations the build ships", () => {
    expect(expectedMigrationCount(journalWith(3))).toBe(3);
  });

  it("says nothing rather than guessing when the journal is missing", () => {
    // Reporting zero keeps a packaging mistake from being read as "the database
    // is behind", which would send someone to the wrong system entirely.
    expect(expectedMigrationCount(join(tmpdir(), "definitely-not-here.json"))).toBe(
      0,
    );
  });

  it("never puts connection details in the response", async () => {
    // This endpoint answers without a session.
    const readiness = await checkReadiness();
    const body = JSON.stringify(readiness);

    expect(body).not.toContain("postgres");
    expect(body).not.toContain("password");
    expect(body).not.toContain("@");
  });
});

describe("the worker's registry", () => {
  it("registers only topics it can actually complete", () => {
    const topics = Object.keys(buildRegistry());

    expect(topics).toContain("search.index");
    expect(topics).toContain("search.remove");
    expect(topics).toContain("media.process");
    // Waiting on a provider. Registering these would mean claiming events and
    // burying them, which destroys the work rather than deferring it.
    expect(topics).not.toContain("notification.send");
    expect(topics).not.toContain("export.requested");
  });

  it("indexes a memorial that was just created or just changed its privacy", () => {
    const registry = buildRegistry();
    expect(registry["memorial.created"]).toBeDefined();
    expect(registry["memorial.privacy_changed"]).toBeDefined();
  });

  it("carries a real event through to the real job", async () => {
    // The registry is the only thing joining the runner to the jobs, and a
    // typo in a topic string would leave the queue silently unclaimed. This is
    // the test that would notice.
    const owner = await makeActor();
    const created = await createMemorial(
      owner,
      {
        relationship: "child",
        relationshipStatementAccepted: true,
        primaryName: { value: `Wiring ${randomUUID().slice(0, 6)}` },
        visibility: "public",
      },
      randomUUID(),
      "req_wiring",
    );
    if (!created.ok) throw new Error("memorial creation failed");

    const [event] = await db()
      .insert(outboxEvents)
      .values({
        topic: "search.index",
        aggregateId: created.value.memorialId,
        payload: { memorialId: created.value.memorialId },
      })
      .returning({ id: outboxEvents.id });

    const summary = await runOnce({ handlers: buildRegistry(), limit: 200 });
    expect(summary.processed).toBeGreaterThanOrEqual(1);

    const [row] = await db()
      .select({ processedAt: outboxEvents.processedAt })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, event!.id));
    expect(row!.processedAt).not.toBeNull();

    const [doc] = await db()
      .select({ memorialId: searchDocuments.memorialId })
      .from(searchDocuments)
      .where(eq(searchDocuments.memorialId, created.value.memorialId));
    expect(doc).toBeDefined();
  });

  it("refuses a removal it cannot identify instead of removing nothing quietly", async () => {
    const registry = buildRegistry();
    const result = await registry["search.remove"]!({}, {
      eventId: "e",
      topic: "search.remove",
      attempts: 1,
    });

    expect(result.handled).toBe(false);
    expect(result).toMatchObject({ retryable: false });
  });
});
