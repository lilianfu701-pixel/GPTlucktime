import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { loginAttempts, loginChallenges } from "@/db/schema";
import { deriveKey, hmacHex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  generateOtpCode,
  hashOtpCode,
  otpCodeMatches,
} from "./otp";

export type LoginChannel = "email" | "phone";

export type VerifyChallengeError =
  | "CHALLENGE_NOT_FOUND"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_LOCKED"
  | "CHALLENGE_ALREADY_USED"
  | "CODE_INCORRECT";

/** Hashes a destination for the attempt log, which must not become an address list. */
export function hashDestination(destination: string, secret: string): string {
  return hmacHex(deriveKey(secret, "destination-log"), destination);
}

/**
 * Issues a challenge and returns the plaintext code exactly once.
 *
 * The caller hands the code to a delivery provider and then discards it. Only
 * the keyed hash is persisted, so the code cannot be recovered from the
 * database or from a backup.
 *
 * Any earlier live challenge for the same destination is consumed first. Two
 * valid codes for one address would double an attacker's guesses and let a
 * stale code be replayed after the person requested a fresh one.
 */
export async function createChallenge(input: {
  channel: LoginChannel;
  destination: string;
  requestIpHash?: string | undefined;
  now?: Date;
}): Promise<{ challengeId: string; code: string; expiresAt: Date }> {
  const secret = env().SESSION_SECRET;
  const now = input.now ?? new Date();
  const code = generateOtpCode();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

  const challengeId = await db().transaction(async (tx) => {
    await tx
      .update(loginChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(loginChallenges.destination, input.destination),
          isNull(loginChallenges.consumedAt),
        ),
      );

    const [row] = await tx
      .insert(loginChallenges)
      .values({
        channel: input.channel,
        destination: input.destination,
        codeHash: hashOtpCode({ code, destination: input.destination, secret }),
        expiresAt,
        requestIpHash: input.requestIpHash ?? null,
      })
      .returning({ id: loginChallenges.id });

    if (!row) {
      throw new Error("login challenge insert returned no row");
    }
    return row.id;
  });

  return { challengeId, code, expiresAt };
}

/**
 * Checks a submitted code.
 *
 * A wrong code increments the counter inside the same statement that reads it,
 * so parallel guesses cannot each see the same pre-increment value. Reaching
 * the limit locks the challenge permanently; the person requests a new code
 * rather than continuing to guess at this one.
 */
export async function verifyChallenge(input: {
  challengeId: string;
  code: string;
  requestIpHash?: string | undefined;
  now?: Date;
}): Promise<
  Result<{ channel: LoginChannel; destination: string }, VerifyChallengeError>
> {
  const secret = env().SESSION_SECRET;
  const now = input.now ?? new Date();

  return db().transaction(async (tx) => {
    // Locked so a burst of parallel guesses is serialized rather than each
    // reading the same attempt count.
    const [challenge] = await tx
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, input.challengeId))
      .for("update");

    if (!challenge) {
      return err("CHALLENGE_NOT_FOUND");
    }

    const record = async (succeeded: boolean, failureReason?: string) => {
      await tx.insert(loginAttempts).values({
        challengeId: challenge.id,
        channel: challenge.channel,
        destinationHash: hashDestination(challenge.destination, secret),
        succeeded,
        failureReason: failureReason ?? null,
        requestIpHash: input.requestIpHash ?? null,
      });
    };

    if (challenge.lockedAt) {
      await record(false, "CHALLENGE_LOCKED");
      return err("CHALLENGE_LOCKED");
    }

    if (challenge.consumedAt) {
      await record(false, "CHALLENGE_ALREADY_USED");
      return err("CHALLENGE_ALREADY_USED");
    }

    if (challenge.expiresAt.getTime() <= now.getTime()) {
      await record(false, "CHALLENGE_EXPIRED");
      return err("CHALLENGE_EXPIRED");
    }

    const matches = otpCodeMatches({
      code: input.code,
      destination: challenge.destination,
      secret,
      storedHash: challenge.codeHash,
    });

    if (!matches) {
      // Incremented by the database, not by a value read earlier in JavaScript.
      // The row lock above already serializes concurrent guesses, but the limit
      // is a security control and should not depend on the lock being correct:
      // `attempts + 1` cannot lose an update under any isolation level.
      const [updated] = await tx
        .update(loginChallenges)
        .set({ attempts: sql`${loginChallenges.attempts} + 1` })
        .where(eq(loginChallenges.id, challenge.id))
        .returning({ attempts: loginChallenges.attempts });

      const attempts = updated?.attempts ?? challenge.attempts + 1;
      const locked = attempts >= OTP_MAX_ATTEMPTS;

      if (locked) {
        await tx
          .update(loginChallenges)
          .set({ lockedAt: now })
          .where(eq(loginChallenges.id, challenge.id));
      }

      await record(false, locked ? "CHALLENGE_LOCKED" : "CODE_INCORRECT");
      return err(locked ? "CHALLENGE_LOCKED" : "CODE_INCORRECT");
    }

    await tx
      .update(loginChallenges)
      .set({ consumedAt: now })
      .where(eq(loginChallenges.id, challenge.id));

    await record(true);

    return ok({
      channel: challenge.channel,
      destination: challenge.destination,
    });
  });
}

/**
 * Removes challenges that expired long enough ago to be of no forensic use.
 * Run from the worker; the attempt log is kept separately and is not touched.
 */
export async function purgeExpiredChallenges(olderThan: Date): Promise<number> {
  const result = await db()
    .delete(loginChallenges)
    .where(lt(loginChallenges.expiresAt, olderThan))
    .returning({ id: loginChallenges.id });
  return result.length;
}

/** Counts verification attempts for a destination since a point in time. */
export async function countRecentAttempts(input: {
  destination: string;
  since: Date;
}): Promise<number> {
  const secret = env().SESSION_SECRET;
  const [row] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(
          loginAttempts.destinationHash,
          hashDestination(input.destination, secret),
        ),
        sql`${loginAttempts.createdAt} >= ${input.since}`,
      ),
    );

  return row?.total ?? 0;
}
