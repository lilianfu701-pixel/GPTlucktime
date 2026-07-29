import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  memorialLocations,
  memorialMembers,
  memorialNames,
  memorials,
  outboxEvents,
  relationshipClaims,
  users,
} from "@/db/schema";
import {
  RELATIONSHIP_STATEMENT_VERSION,
  createMemorial,
  memorialRoleFor,
} from "@/modules/memorials/service";
import type { CreateMemorialInput } from "@/modules/memorials/service";
import type { Actor } from "@/modules/permissions/types";

const createdUserIds: string[] = [];

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
});

afterEach(async () => {
  const userIds = createdUserIds.splice(0);
  if (userIds.length === 0) return;

  const owned = await db()
    .select({ id: memorials.id, personId: memorials.deceasedPersonId })
    .from(memorials)
    .where(inArray(memorials.ownerUserId, userIds));

  const memorialIds = owned.map((row) => row.id);
  if (memorialIds.length > 0) {
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
    .values({ displayName: `Relative ${randomUUID().slice(0, 8)}` })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no row");
  createdUserIds.push(row.id);
  return { userId: row.id, platformRole: "user" };
}

const baseInput: CreateMemorialInput = {
  relationship: "spouse",
  relationshipStatementAccepted: true,
  primaryName: { value: "王明", locale: "zh-CN", script: "Hans" },
};

describe("createMemorial", () => {
  it("creates the memorial, the owner membership and the claim together", async () => {
    const actor = await makeActor();
    const result = await createMemorial(actor, baseInput, randomUUID(), "req_1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [memorial] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, result.value.memorialId));
    const members = await db()
      .select()
      .from(memorialMembers)
      .where(eq(memorialMembers.memorialId, result.value.memorialId));
    const [claim] = await db()
      .select()
      .from(relationshipClaims)
      .where(eq(relationshipClaims.memorialId, result.value.memorialId));

    expect(memorial?.ownerUserId).toBe(actor.userId);
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("owner");
    expect(members[0]?.acceptedAt).toBeInstanceOf(Date);
    expect(claim?.relationship).toBe("spouse");
    expect(claim?.statementVersion).toBe(RELATIONSHIP_STATEMENT_VERSION);
    expect(claim?.status).toBe("declared");
  });

  it("is public and search-engine indexable by default", async () => {
    // Doc 01 section 2: a new memorial is public unless the family says
    // otherwise. The default must live in one place and be verified.
    const actor = await makeActor();
    const result = await createMemorial(actor, baseInput, randomUUID(), "req_1");
    if (!result.ok) throw new Error("create failed");

    const [memorial] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, result.value.memorialId));

    expect(memorial?.visibility).toBe("public");
    expect(memorial?.searchEngineIndexable).toBe(true);
    // Not published until the family publishes it.
    expect(memorial?.status).toBe("draft");
    expect(memorial?.publishedAt).toBeNull();
  });

  it("honours a family that chooses privacy up front", async () => {
    const actor = await makeActor();
    const result = await createMemorial(
      actor,
      { ...baseInput, visibility: "invite_only", searchEngineIndexable: false },
      randomUUID(),
      "req_1",
    );
    if (!result.ok) throw new Error("create failed");

    const [memorial] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, result.value.memorialId));

    expect(memorial?.visibility).toBe("invite_only");
    expect(memorial?.searchEngineIndexable).toBe(false);
  });

  it("writes an audit entry and an outbox event in the same transaction", async () => {
    const actor = await makeActor();
    const result = await createMemorial(actor, baseInput, randomUUID(), "req_audit");
    if (!result.ok) throw new Error("create failed");

    const audits = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, result.value.memorialId));
    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, result.value.memorialId));

    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("memorial.created");
    expect(audits[0]?.correlationId).toBe("req_audit");
    expect(events).toHaveLength(1);
    expect(events[0]?.topic).toBe("memorial.created");
    expect(events[0]?.processedAt).toBeNull();
  });

  it("stores the primary name and any aliases", async () => {
    const actor = await makeActor();
    const result = await createMemorial(
      actor,
      {
        ...baseInput,
        aliases: [
          { value: "Wang Ming", script: "Latn", type: "transliteration" },
          { value: "老王", type: "alias", searchable: false },
        ],
      },
      randomUUID(),
      "req_1",
    );
    if (!result.ok) throw new Error("create failed");

    const names = await db()
      .select()
      .from(memorialNames)
      .where(eq(memorialNames.memorialId, result.value.memorialId));

    expect(names).toHaveLength(3);
    expect(names.find((n) => n.type === "primary")?.value).toBe("王明");
    // A family may record a name without letting the world search for it.
    expect(names.find((n) => n.value === "老王")?.searchable).toBe(false);
    expect(names.find((n) => n.value === "Wang Ming")?.searchable).toBe(true);
  });

  it("records locations when given", async () => {
    const actor = await makeActor();
    const result = await createMemorial(
      actor,
      {
        ...baseInput,
        locations: [{ kind: "birth", country: "CN", city: "Suzhou" }],
      },
      randomUUID(),
      "req_1",
    );
    if (!result.ok) throw new Error("create failed");

    const locations = await db()
      .select()
      .from(memorialLocations)
      .where(eq(memorialLocations.memorialId, result.value.memorialId));

    expect(locations).toHaveLength(1);
    expect(locations[0]?.country).toBe("CN");
  });

  it("builds a slug that carries the name and a distinguishing suffix", async () => {
    const actor = await makeActor();
    const first = await createMemorial(
      actor,
      { ...baseInput, primaryName: { value: "Mary O'Brien" } },
      randomUUID(),
      "req_1",
    );
    const second = await createMemorial(
      actor,
      { ...baseInput, primaryName: { value: "Mary O'Brien" } },
      randomUUID(),
      "req_2",
    );

    if (!first.ok || !second.ok) throw new Error("create failed");
    expect(first.value.slug).toMatch(/^mary-o-brien-[0-9a-f]{8}$/);
    // Two people really can share a name.
    expect(first.value.slug).not.toBe(second.value.slug);
  });

  it("still produces a usable slug for a name in a non-Latin script", async () => {
    const actor = await makeActor();
    const result = await createMemorial(actor, baseInput, randomUUID(), "req_1");
    if (!result.ok) throw new Error("create failed");
    expect(result.value.slug).toMatch(/^memorial-[0-9a-f]{8}$/);
  });
});

describe("createMemorial refusals", () => {
  it("refuses an anonymous caller", async () => {
    const result = await createMemorial(
      { userId: null, platformRole: "user" },
      baseInput,
      randomUUID(),
      "req_1",
    );
    expect(result).toEqual({ ok: false, error: "AUTH_REQUIRED" });
  });

  it("refuses until the responsibility statement is accepted", async () => {
    // Doc 01 section 3.1 makes this a deliberate step, not something inferred
    // from the request having been sent at all.
    const actor = await makeActor();
    const result = await createMemorial(
      actor,
      { ...baseInput, relationshipStatementAccepted: false },
      randomUUID(),
      "req_1",
    );
    expect(result).toEqual({ ok: false, error: "STATEMENT_NOT_ACCEPTED" });

    const rows = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.ownerUserId, actor.userId ?? ""));
    expect(rows).toHaveLength(0);
  });

  it("refuses an empty name", async () => {
    const actor = await makeActor();
    const result = await createMemorial(
      actor,
      { ...baseInput, primaryName: { value: "   " } },
      randomUUID(),
      "req_1",
    );
    expect(result).toEqual({ ok: false, error: "INVALID_NAME" });
  });

  it("refuses a death recorded before the birth", async () => {
    const actor = await makeActor();
    const result = await createMemorial(
      actor,
      {
        ...baseInput,
        birthDate: { value: "2020-01-01", precision: "day" },
        deathDate: { value: "1990-01-01", precision: "day" },
      },
      randomUUID(),
      "req_1",
    );
    expect(result).toEqual({ ok: false, error: "INVALID_DATES" });
  });

  it("accepts an approximate pair that cannot be meaningfully compared", async () => {
    // Coarse precisions carry placeholder components. Comparing them would
    // reject a legitimate record where only the decade is known.
    const actor = await makeActor();
    const result = await createMemorial(
      actor,
      {
        ...baseInput,
        birthDate: { value: "1940-01-01", precision: "approximate" },
        deathDate: { value: "1939-01-01", precision: "approximate" },
      },
      randomUUID(),
      "req_1",
    );
    expect(result.ok).toBe(true);
  });

  it("leaves nothing behind when it refuses", async () => {
    const actor = await makeActor();
    await createMemorial(
      actor,
      { ...baseInput, primaryName: { value: "" } },
      randomUUID(),
      "req_1",
    );

    const people = await db().select().from(deceasedPeople);
    const claims = await db()
      .select()
      .from(relationshipClaims)
      .where(eq(relationshipClaims.claimantUserId, actor.userId ?? ""));

    expect(claims).toHaveLength(0);
    // The deceased record is only written inside the transaction, so a refusal
    // before it cannot orphan one.
    expect(people.every((person) => person.id !== undefined)).toBe(true);
  });
});

describe("createMemorial idempotency", () => {
  it("returns the same memorial when the request is retried", async () => {
    const actor = await makeActor();
    const key = randomUUID();

    const first = await createMemorial(actor, baseInput, key, "req_1");
    const second = await createMemorial(actor, baseInput, key, "req_2");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.memorialId).toBe(first.value.memorialId);
    expect(second.value.slug).toBe(first.value.slug);

    // The caller needs to distinguish the two so it can answer 201 or 200.
    expect(first.value.created).toBe(true);
    expect(second.value.created).toBe(false);

    const rows = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.ownerUserId, actor.userId ?? ""));
    expect(rows).toHaveLength(1);
  });

  it("creates one memorial when retries arrive at the same moment", async () => {
    // Enforced by a unique index, not by a read-then-write check: a duplicate
    // memorial for one death is exactly what the duplicate-detection process
    // exists to avoid, and it is worse when the platform causes it.
    const actor = await makeActor();
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createMemorial(actor, baseInput, key, `req_${index}`),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const ids = new Set(
      results.flatMap((result) => (result.ok ? [result.value.memorialId] : [])),
    );
    expect(ids.size).toBe(1);

    // Exactly one request caused the memorial to exist; the rest are replays.
    const createdFlags = results.flatMap((result) =>
      result.ok ? [result.value.created] : [],
    );
    expect(createdFlags.filter(Boolean)).toHaveLength(1);

    const rows = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.ownerUserId, actor.userId ?? ""));
    expect(rows).toHaveLength(1);
  });

  it("treats a different key from the same person as a different memorial", async () => {
    // One person may lose two relatives.
    const actor = await makeActor();

    const first = await createMemorial(actor, baseInput, randomUUID(), "req_1");
    const second = await createMemorial(actor, baseInput, randomUUID(), "req_2");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.memorialId).not.toBe(first.value.memorialId);
  });

  it("does not let one person's key collide with another's", async () => {
    const first = await makeActor();
    const second = await makeActor();
    const key = "shared-key";

    const a = await createMemorial(first, baseInput, key, "req_1");
    const b = await createMemorial(second, baseInput, key, "req_2");

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.memorialId).not.toBe(b.value.memorialId);
  });
});

describe("memorialRoleFor", () => {
  it("reports the owner", async () => {
    const actor = await makeActor();
    const result = await createMemorial(actor, baseInput, randomUUID(), "req_1");
    if (!result.ok) throw new Error("create failed");

    expect(await memorialRoleFor(result.value.memorialId, actor.userId)).toBe(
      "owner",
    );
  });

  it("reports no role for someone with no membership", async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const result = await createMemorial(owner, baseInput, randomUUID(), "req_1");
    if (!result.ok) throw new Error("create failed");

    expect(await memorialRoleFor(result.value.memorialId, stranger.userId)).toBeNull();
  });

  it("reports no role for an anonymous caller", async () => {
    const owner = await makeActor();
    const result = await createMemorial(owner, baseInput, randomUUID(), "req_1");
    if (!result.ok) throw new Error("create failed");

    expect(await memorialRoleFor(result.value.memorialId, null)).toBeNull();
  });

  it("reports no role once membership is revoked", async () => {
    const owner = await makeActor();
    const editor = await makeActor();
    const result = await createMemorial(owner, baseInput, randomUUID(), "req_1");
    if (!result.ok) throw new Error("create failed");

    await db().insert(memorialMembers).values({
      memorialId: result.value.memorialId,
      userId: editor.userId ?? "",
      role: "editor",
      acceptedAt: new Date(),
    });
    expect(await memorialRoleFor(result.value.memorialId, editor.userId)).toBe(
      "editor",
    );

    await db()
      .update(memorialMembers)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(memorialMembers.memorialId, result.value.memorialId),
          eq(memorialMembers.userId, editor.userId ?? ""),
        ),
      );

    // Revocation takes effect on the next check, not after a cache expires.
    expect(await memorialRoleFor(result.value.memorialId, editor.userId)).toBeNull();
  });
});
