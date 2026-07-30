import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { deriveKey, hmacHex, randomTokenHex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";

/** Thirty days. A memorial is revisited over months, not minutes. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = "memorial_session";

export type SessionError =
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "USER_UNAVAILABLE";

/** Only this hash is stored, so a database copy cannot be replayed as a login. */
export function hashSessionToken(token: string, secret: string): string {
  return hmacHex(deriveKey(secret, "session-token"), token);
}

/**
 * Issues a session and returns the token exactly once, for the cookie.
 */
export async function createSession(input: {
  userId: string;
  ipHash?: string | undefined;
  userAgent?: string | undefined;
  now?: Date;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomTokenHex(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const [row] = await db()
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: hashSessionToken(token, env().SESSION_SECRET),
      expiresAt,
      ipHash: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning({ id: sessions.id });

  if (!row) {
    throw new Error("session insert returned no row");
  }

  return { token, sessionId: row.id, expiresAt };
}

/**
 * Resolves a cookie value to the signed-in person.
 *
 * A suspended or deleted account fails here rather than at each call site, so
 * revoking access does not depend on every feature remembering to check.
 */
export async function resolveSession(input: {
  token: string;
  now?: Date;
}): Promise<
  Result<
    {
      userId: string;
      sessionId: string;
      preferredLocale: string;
      platformRole: "user" | "reviewer" | "super_admin";
    },
    SessionError
  >
> {
  const now = input.now ?? new Date();
  const tokenHash = hashSessionToken(input.token, env().SESSION_SECRET);

  const [row] = await db()
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      status: users.status,
      deletedAt: users.deletedAt,
      preferredLocale: users.preferredLocale,
      platformRole: users.platformRole,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash));

  if (!row) {
    return err("SESSION_NOT_FOUND");
  }

  if (row.revokedAt) {
    return err("SESSION_REVOKED");
  }

  if (row.expiresAt.getTime() <= now.getTime()) {
    return err("SESSION_EXPIRED");
  }

  if (row.status !== "active" || row.deletedAt) {
    return err("USER_UNAVAILABLE");
  }

  return ok({
    userId: row.userId,
    sessionId: row.sessionId,
    preferredLocale: row.preferredLocale,
    platformRole: row.platformRole,
  });
}

export async function revokeSession(input: {
  sessionId: string;
  now?: Date;
}): Promise<void> {
  await db()
    .update(sessions)
    .set({ revokedAt: input.now ?? new Date() })
    .where(and(eq(sessions.id, input.sessionId), isNull(sessions.revokedAt)));
}

/** Used when an account is compromised or the person signs out everywhere. */
export async function revokeAllSessionsForUser(input: {
  userId: string;
  now?: Date;
}): Promise<number> {
  const revoked = await db()
    .update(sessions)
    .set({ revokedAt: input.now ?? new Date() })
    .where(and(eq(sessions.userId, input.userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  return revoked.length;
}

export async function touchSession(input: {
  sessionId: string;
  now?: Date;
}): Promise<void> {
  await db()
    .update(sessions)
    .set({ lastSeenAt: input.now ?? new Date() })
    .where(eq(sessions.id, input.sessionId));
}
