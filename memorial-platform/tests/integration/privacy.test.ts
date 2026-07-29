import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  emailCredentials,
  memorialInvitations,
  memorialMembers,
  memorials,
  outboxEvents,
  users,
} from "@/db/schema";
import { resolveAccessById } from "@/modules/memorials/access";
import {
  acceptInvitation,
  inviteMember,
  revokeMembership,
} from "@/modules/memorials/invitations";
import { changePrivacy } from "@/modules/memorials/privacy";
import { createMemorial } from "@/modules/memorials/service";
import type { Actor } from "@/modules/permissions/types";

const createdUserIds: string[] = [];
const anonymous: Actor = { userId: null, platformRole: "user" };

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
    await db()
      .delete(memorialInvitations)
      .where(inArray(memorialInvitations.memorialId, memorialIds));
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

async function makeActor(email?: string): Promise<Actor> {
  const [row] = await db()
    .insert(users)
    .values({ displayName: `Person ${randomUUID().slice(0, 8)}` })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no row");
  createdUserIds.push(row.id);

  if (email) {
    await db()
      .insert(emailCredentials)
      .values({ userId: row.id, email, verifiedAt: new Date() });
  }

  return { userId: row.id, platformRole: "user" };
}

async function makeMemorial(
  owner: Actor,
  visibility: "public" | "unlisted" | "invite_only" = "public",
): Promise<string> {
  const result = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
      visibility,
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");

  // Publish so access reflects visibility rather than draft status.
  await db()
    .update(memorials)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(memorials.id, result.value.memorialId));

  return result.value.memorialId;
}

describe("access by visibility", () => {
  it("lets anyone see a public memorial", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "public");

    expect(await resolveAccessById(memorialId, anonymous)).toEqual({
      allowed: true,
      role: "public_visitor",
    });
  });

  it("lets a link holder see an unlisted memorial", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "unlisted");

    expect(await resolveAccessById(memorialId, anonymous)).toEqual({
      allowed: true,
      role: "public_visitor",
    });
  });

  it("hides an invite-only memorial behind NOT_FOUND", async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");

    expect(await resolveAccessById(memorialId, anonymous)).toEqual({
      allowed: false,
      reason: "NOT_FOUND",
    });
    expect(await resolveAccessById(memorialId, stranger)).toEqual({
      allowed: false,
      reason: "NOT_FOUND",
    });
  });

  it("gives the same answer for an invite-only memorial and one that never existed", async () => {
    // A probe must not be able to tell the two apart.
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");

    const hidden = await resolveAccessById(memorialId, stranger);
    const missing = await resolveAccessById(randomUUID(), stranger);

    expect(hidden).toEqual(missing);
  });

  it("lets the owner in whatever the visibility", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");

    expect(await resolveAccessById(memorialId, owner)).toEqual({
      allowed: true,
      role: "owner",
    });
  });
});

describe("changePrivacy", () => {
  it("is refused to everyone but the owner", async () => {
    const owner = await makeActor();
    const admin = await makeActor();
    const memorialId = await makeMemorial(owner);

    await db().insert(memorialMembers).values({
      memorialId,
      userId: admin.userId ?? "",
      role: "admin",
      acceptedAt: new Date(),
    });

    expect(
      await changePrivacy(admin, memorialId, { visibility: "invite_only" }, "req_1"),
    ).toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });

    const [memorial] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, memorialId));
    expect(memorial?.visibility).toBe("public");
  });

  it("tells a stranger the memorial does not exist", async () => {
    // Answering FORBIDDEN would confirm it exists.
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await changePrivacy(
        stranger,
        memorialId,
        { visibility: "invite_only" },
        "req_1",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });

  it("revokes access on the very next request", async () => {
    // The row is the truth. Nothing about protecting a family may wait for a
    // worker to catch up with the search index.
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner, "public");

    expect((await resolveAccessById(memorialId, stranger)).allowed).toBe(true);

    const result = await changePrivacy(
      owner,
      memorialId,
      { visibility: "invite_only" },
      "req_1",
    );
    expect(result.ok).toBe(true);

    expect(await resolveAccessById(memorialId, stranger)).toEqual({
      allowed: false,
      reason: "NOT_FOUND",
    });
  });

  it("enqueues removal from the search index when it stops being public", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "public");

    await changePrivacy(owner, memorialId, { visibility: "unlisted" }, "req_1");

    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, memorialId));
    const topics = events.map((event) => event.topic);

    expect(topics).toContain("memorial.privacy_changed");
    expect(topics).toContain("search.remove");
    expect(topics).not.toContain("search.index");
  });

  it("enqueues indexing when it becomes public again", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");

    await changePrivacy(
      owner,
      memorialId,
      { visibility: "public", confirmPublicExposure: true },
      "req_1",
    );

    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, memorialId));
    expect(events.map((event) => event.topic)).toContain("search.index");
  });

  it("requires an explicit confirmation before going public", async () => {
    // Doc 01 section 3.3. Once it is public a search engine may keep a copy,
    // so consent is asked for rather than inferred.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");

    expect(
      await changePrivacy(owner, memorialId, { visibility: "public" }, "req_1"),
    ).toEqual({ ok: false, error: "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED" });

    const [memorial] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, memorialId));
    expect(memorial?.visibility).toBe("invite_only");
  });

  it("accepts the change once the owner confirms", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");

    const result = await changePrivacy(
      owner,
      memorialId,
      { visibility: "public", confirmPublicExposure: true },
      "req_1",
    );

    expect(result.ok).toBe(true);
    expect(
      (await resolveAccessById(memorialId, anonymous)).allowed,
    ).toBe(true);
  });

  it("needs no confirmation to become more private", async () => {
    // Closing a memorial is always allowed without ceremony.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "public");

    expect(
      (await changePrivacy(owner, memorialId, { visibility: "invite_only" }, "req_1"))
        .ok,
    ).toBe(true);
  });

  it("records the old and the new setting", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "public");

    await changePrivacy(owner, memorialId, { visibility: "unlisted" }, "req_audit");

    const [entry] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, "req_audit"));

    expect(entry?.action).toBe("memorial.privacy_changed");
    expect(entry?.oldValue).toMatchObject({ visibility: "public" });
    expect(entry?.newValue).toMatchObject({ visibility: "unlisted" });
  });

  it("reports an unchanged setting without writing history", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "public");

    const result = await changePrivacy(
      owner,
      memorialId,
      { visibility: "public" },
      "req_noop",
    );

    expect(result.ok && result.value.changed).toBe(false);
    const entries = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, "req_noop"));
    expect(entries).toHaveLength(0);
  });
});

describe("invitations", () => {
  it("lets an invited person in, and nobody else", async () => {
    const owner = await makeActor();
    const guestEmail = `guest-${randomUUID()}@example.test`;
    const guest = await makeActor(guestEmail);
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");

    const invite = await inviteMember(
      owner,
      memorialId,
      { email: guestEmail, role: "invited_visitor" },
      "req_1",
    );
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    // Before accepting, the guest still cannot see it.
    expect((await resolveAccessById(memorialId, guest)).allowed).toBe(false);

    const accepted = await acceptInvitation(guest, invite.value.token, "req_2");
    expect(accepted.ok).toBe(true);

    expect(await resolveAccessById(memorialId, guest)).toEqual({
      allowed: true,
      role: "invited_visitor",
    });
    expect((await resolveAccessById(memorialId, stranger)).allowed).toBe(false);
  });

  it("stores only a hash of the token", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    const invite = await inviteMember(
      owner,
      memorialId,
      { email: `x-${randomUUID()}@example.test`, role: "editor" },
      "req_1",
    );
    if (!invite.ok) throw new Error("invite failed");

    const [row] = await db()
      .select()
      .from(memorialInvitations)
      .where(eq(memorialInvitations.id, invite.value.invitationId));

    expect(row?.tokenHash).not.toBe(invite.value.token);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cannot be used twice", async () => {
    const owner = await makeActor();
    const guestEmail = `guest-${randomUUID()}@example.test`;
    const guest = await makeActor(guestEmail);
    const other = await makeActor();
    const memorialId = await makeMemorial(owner);

    const invite = await inviteMember(
      owner,
      memorialId,
      { email: guestEmail, role: "editor" },
      "req_1",
    );
    if (!invite.ok) throw new Error("invite failed");

    expect((await acceptInvitation(guest, invite.value.token, "req_2")).ok).toBe(
      true,
    );
    // A forwarded link must not let a second person in.
    expect(await acceptInvitation(other, invite.value.token, "req_3")).toEqual({
      ok: false,
      error: "INVITATION_ALREADY_USED",
    });
  });

  it("refuses an unknown token", async () => {
    const guest = await makeActor();
    expect(await acceptInvitation(guest, "f".repeat(64), "req_1")).toEqual({
      ok: false,
      error: "INVITATION_NOT_FOUND",
    });
  });

  it("refuses an expired invitation", async () => {
    const owner = await makeActor();
    const guestEmail = `guest-${randomUUID()}@example.test`;
    const guest = await makeActor(guestEmail);
    const memorialId = await makeMemorial(owner);

    const invite = await inviteMember(
      owner,
      memorialId,
      { email: guestEmail, role: "editor" },
      "req_1",
    );
    if (!invite.ok) throw new Error("invite failed");

    await db()
      .update(memorialInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(memorialInvitations.id, invite.value.invitationId));

    expect(await acceptInvitation(guest, invite.value.token, "req_2")).toEqual({
      ok: false,
      error: "INVITATION_EXPIRED",
    });
  });

  it("will not hand out ownership", async () => {
    // Ownership moves by explicit transfer, never by sending someone a link.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    const result = await inviteMember(
      owner,
      memorialId,
      {
        email: `x-${randomUUID()}@example.test`,
        role: "owner" as unknown as "admin",
      },
      "req_1",
    );

    expect(result).toEqual({ ok: false, error: "ROLE_NOT_INVITABLE" });
  });

  it("is refused to an editor, who cannot manage members", async () => {
    const owner = await makeActor();
    const editor = await makeActor();
    const memorialId = await makeMemorial(owner);

    await db().insert(memorialMembers).values({
      memorialId,
      userId: editor.userId ?? "",
      role: "editor",
      acceptedAt: new Date(),
    });

    expect(
      await inviteMember(
        editor,
        memorialId,
        { email: `x-${randomUUID()}@example.test`, role: "editor" },
        "req_1",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });
  });

  it("tells a stranger the memorial does not exist", async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await inviteMember(
        stranger,
        memorialId,
        { email: `x-${randomUUID()}@example.test`, role: "editor" },
        "req_1",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });
});

describe("revoking membership", () => {
  it("removes access on the next request", async () => {
    const owner = await makeActor();
    const editor = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");

    await db().insert(memorialMembers).values({
      memorialId,
      userId: editor.userId ?? "",
      role: "editor",
      acceptedAt: new Date(),
    });
    expect((await resolveAccessById(memorialId, editor)).allowed).toBe(true);

    const revoked = await revokeMembership(
      owner,
      memorialId,
      editor.userId ?? "",
      "req_1",
    );
    expect(revoked.ok).toBe(true);

    expect(await resolveAccessById(memorialId, editor)).toEqual({
      allowed: false,
      reason: "NOT_FOUND",
    });
  });

  it("keeps the row so a dispute can show who had access", async () => {
    const owner = await makeActor();
    const editor = await makeActor();
    const memorialId = await makeMemorial(owner);

    await db().insert(memorialMembers).values({
      memorialId,
      userId: editor.userId ?? "",
      role: "editor",
      acceptedAt: new Date(),
    });
    await revokeMembership(owner, memorialId, editor.userId ?? "", "req_1");

    const rows = await db()
      .select()
      .from(memorialMembers)
      .where(eq(memorialMembers.memorialId, memorialId));

    const revokedRow = rows.find((row) => row.userId === editor.userId);
    expect(revokedRow).toBeDefined();
    expect(revokedRow?.revokedAt).toBeInstanceOf(Date);
  });

  it("will not strip the owner of their own memorial", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await revokeMembership(owner, memorialId, owner.userId ?? "", "req_1"),
    ).toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });
  });
});
