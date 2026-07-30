import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  emailCredentials,
  sessions,
  userIdentities,
  users,
} from "@/db/schema";
import {
  SESSION_TTL_MS,
  createSession,
  resolveSession,
  revokeAllSessionsForUser,
  revokeSession,
} from "@/modules/auth/sessions";

const createdUserIds: string[] = [];

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
});

afterEach(async () => {
  // Cascades remove sessions, credentials and identities with the user.
  for (const id of createdUserIds.splice(0)) {
    await db().delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await closeDb();
});

async function makeUser(
  overrides: { status?: "active" | "suspended"; deletedAt?: Date } = {},
): Promise<string> {
  const [row] = await db()
    .insert(users)
    .values({
      displayName: `Test ${randomUUID().slice(0, 8)}`,
      status: overrides.status ?? "active",
      deletedAt: overrides.deletedAt ?? null,
    })
    .returning({ id: users.id });

  if (!row) {
    throw new Error("user insert returned no row");
  }
  createdUserIds.push(row.id);
  return row.id;
}

describe("createSession", () => {
  it("stores only a hash of the token", async () => {
    const userId = await makeUser();
    const { token, sessionId } = await createSession({ userId });

    const [row] = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cannot be replayed from the stored hash", async () => {
    // Someone holding a copy of the table must not be able to sign in with what
    // they find there.
    const userId = await makeUser();
    const { sessionId } = await createSession({ userId });

    const [row] = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));

    const result = await resolveSession({ token: row?.tokenHash ?? "" });
    expect(result).toEqual({ ok: false, error: "SESSION_NOT_FOUND" });
  });

  it("sets the documented lifetime", async () => {
    const userId = await makeUser();
    const now = new Date("2026-07-29T12:00:00.000Z");
    const { expiresAt } = await createSession({ userId, now });

    expect(expiresAt.getTime() - now.getTime()).toBe(SESSION_TTL_MS);
  });

  it("issues a different token every time", async () => {
    const userId = await makeUser();
    const first = await createSession({ userId });
    const second = await createSession({ userId });

    expect(first.token).not.toBe(second.token);
  });

  it("records only a hashed address for the client", async () => {
    const userId = await makeUser();
    const { sessionId } = await createSession({
      userId,
      ipHash: "a".repeat(64),
      userAgent: "Mozilla/5.0",
    });

    const [row] = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));

    expect(row?.ipHash).toBe("a".repeat(64));
    expect(row?.userAgent).toBe("Mozilla/5.0");
  });
});

describe("resolveSession", () => {
  it("returns the signed-in person for a live token", async () => {
    const userId = await makeUser();
    const { token, sessionId } = await createSession({ userId });

    expect(await resolveSession({ token })).toEqual({
      ok: true,
      value: {
        userId,
        sessionId,
        preferredLocale: "en",
        // An account gains nothing by existing. Staff capability is a
        // deliberate database action, so a new account resolves to "user".
        platformRole: "user",
      },
    });
  });

  it("rejects an unknown token", async () => {
    expect(await resolveSession({ token: "f".repeat(64) })).toEqual({
      ok: false,
      error: "SESSION_NOT_FOUND",
    });
  });

  it("rejects a malformed token without throwing", async () => {
    expect((await resolveSession({ token: "" })).ok).toBe(false);
    expect((await resolveSession({ token: "not-a-token" })).ok).toBe(false);
  });

  it("rejects an expired session", async () => {
    const userId = await makeUser();
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const { token } = await createSession({ userId, now: issuedAt });

    const afterExpiry = new Date(issuedAt.getTime() + SESSION_TTL_MS + 1);
    expect(await resolveSession({ token, now: afterExpiry })).toEqual({
      ok: false,
      error: "SESSION_EXPIRED",
    });
  });

  it("rejects a revoked session immediately", async () => {
    const userId = await makeUser();
    const { token, sessionId } = await createSession({ userId });

    expect((await resolveSession({ token })).ok).toBe(true);
    await revokeSession({ sessionId });
    expect(await resolveSession({ token })).toEqual({
      ok: false,
      error: "SESSION_REVOKED",
    });
  });

  it("refuses a session belonging to a suspended account", async () => {
    // Checked centrally so suspending an account does not depend on every
    // feature remembering to look at user status.
    const userId = await makeUser({ status: "suspended" });
    const { token } = await createSession({ userId });

    expect(await resolveSession({ token })).toEqual({
      ok: false,
      error: "USER_UNAVAILABLE",
    });
  });

  it("refuses a session belonging to a soft-deleted account", async () => {
    const userId = await makeUser({ deletedAt: new Date() });
    const { token } = await createSession({ userId });

    expect(await resolveSession({ token })).toEqual({
      ok: false,
      error: "USER_UNAVAILABLE",
    });
  });
});

describe("revokeAllSessionsForUser", () => {
  it("ends every live session and leaves other people alone", async () => {
    const userId = await makeUser();
    const otherUserId = await makeUser();

    const first = await createSession({ userId });
    const second = await createSession({ userId });
    const other = await createSession({ userId: otherUserId });

    const revoked = await revokeAllSessionsForUser({ userId });

    expect(revoked).toBe(2);
    expect((await resolveSession({ token: first.token })).ok).toBe(false);
    expect((await resolveSession({ token: second.token })).ok).toBe(false);
    expect((await resolveSession({ token: other.token })).ok).toBe(true);
  });

  it("does not re-revoke an already revoked session", async () => {
    const userId = await makeUser();
    await createSession({ userId });

    expect(await revokeAllSessionsForUser({ userId })).toBe(1);
    expect(await revokeAllSessionsForUser({ userId })).toBe(0);
  });
});

describe("identity uniqueness", () => {
  it("allows one account per normalized address", async () => {
    const userId = await makeUser();
    const otherUserId = await makeUser();
    const email = `unique-${randomUUID()}@example.test`;

    await db().insert(emailCredentials).values({ userId, email });

    await expect(
      db().insert(emailCredentials).values({ userId: otherUserId, email }),
    ).rejects.toThrow();
  });

  it("allows one account per social provider subject", async () => {
    const userId = await makeUser();
    const otherUserId = await makeUser();
    const providerSubject = `google-${randomUUID()}`;

    await db()
      .insert(userIdentities)
      .values({ userId, provider: "google", providerSubject });

    await expect(
      db()
        .insert(userIdentities)
        .values({ userId: otherUserId, provider: "google", providerSubject }),
    ).rejects.toThrow();
  });

  it("treats the same subject from two providers as two identities", async () => {
    // Google and Apple subjects live in separate namespaces; colliding strings
    // must not be read as the same person.
    const userId = await makeUser();
    const providerSubject = `subject-${randomUUID()}`;

    await db()
      .insert(userIdentities)
      .values({ userId, provider: "google", providerSubject });
    await db()
      .insert(userIdentities)
      .values({ userId, provider: "apple", providerSubject });

    const rows = await db()
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId));

    expect(rows).toHaveLength(2);
  });

  it("removes sessions and credentials when the account row is deleted", async () => {
    const userId = await makeUser();
    const { sessionId } = await createSession({ userId });
    await db()
      .insert(emailCredentials)
      .values({ userId, email: `cascade-${randomUUID()}@example.test` });

    await db().delete(users).where(eq(users.id, userId));
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);

    const remainingSessions = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const remainingCredentials = await db()
      .select()
      .from(emailCredentials)
      .where(eq(emailCredentials.userId, userId));

    expect(remainingSessions).toHaveLength(0);
    expect(remainingCredentials).toHaveLength(0);
  });
});
