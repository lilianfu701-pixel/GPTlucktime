import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import { loginAttempts, loginChallenges } from "@/db/schema";
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "@/modules/auth/otp";
import {
  createChallenge,
  verifyChallenge,
  purgeExpiredChallenges,
} from "@/modules/auth/otp-store";

/** Unique per test so cleanup never touches another suite's rows. */
let destination: string;

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
});

beforeEach(() => {
  destination = `otp-${randomUUID()}@example.test`;
});

afterAll(async () => {
  await closeDb();
});

async function cleanup(target: string): Promise<void> {
  const rows = await db()
    .select({ id: loginChallenges.id })
    .from(loginChallenges)
    .where(eq(loginChallenges.destination, target));

  for (const row of rows) {
    await db().delete(loginAttempts).where(eq(loginAttempts.challengeId, row.id));
  }
  await db().delete(loginChallenges).where(eq(loginChallenges.destination, target));
}

describe("createChallenge", () => {
  it("returns the code once and stores only a hash of it", async () => {
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
    });

    const [row] = await db()
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId));

    expect(code).toMatch(/^\d{6}$/);
    expect(row?.codeHash).not.toContain(code);
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.attempts).toBe(0);
    expect(row?.consumedAt).toBeNull();
    expect(row?.lockedAt).toBeNull();

    await cleanup(destination);
  });

  it("expires the code ten minutes out", async () => {
    const now = new Date("2026-07-29T12:00:00.000Z");
    const { challengeId, expiresAt } = await createChallenge({
      channel: "email",
      destination,
      now,
    });

    expect(expiresAt.getTime() - now.getTime()).toBe(OTP_TTL_MS);

    const [row] = await db()
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId));
    expect(row?.expiresAt.toISOString()).toBe("2026-07-29T12:10:00.000Z");

    await cleanup(destination);
  });

  it("retires an earlier live challenge for the same destination", async () => {
    // Two valid codes at once would double an attacker's guesses, and would let
    // an old code still work after the person asked for a fresh one.
    const first = await createChallenge({ channel: "email", destination });
    const second = await createChallenge({ channel: "email", destination });

    const firstResult = await verifyChallenge({
      challengeId: first.challengeId,
      code: first.code,
    });
    expect(firstResult).toEqual({ ok: false, error: "CHALLENGE_ALREADY_USED" });

    const secondResult = await verifyChallenge({
      challengeId: second.challengeId,
      code: second.code,
    });
    expect(secondResult.ok).toBe(true);

    await cleanup(destination);
  });

  it("does not disturb a live challenge for a different destination", async () => {
    const other = `otp-${randomUUID()}@example.test`;
    const mine = await createChallenge({ channel: "email", destination });
    await createChallenge({ channel: "email", destination: other });

    const result = await verifyChallenge({
      challengeId: mine.challengeId,
      code: mine.code,
    });
    expect(result.ok).toBe(true);

    await cleanup(destination);
    await cleanup(other);
  });
});

describe("verifyChallenge", () => {
  it("accepts the correct code and reports the destination", async () => {
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
    });

    const result = await verifyChallenge({ challengeId, code });

    expect(result).toEqual({
      ok: true,
      value: { channel: "email", destination },
    });

    await cleanup(destination);
  });

  it("refuses to accept the same code twice", async () => {
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
    });

    expect((await verifyChallenge({ challengeId, code })).ok).toBe(true);
    expect(await verifyChallenge({ challengeId, code })).toEqual({
      ok: false,
      error: "CHALLENGE_ALREADY_USED",
    });

    await cleanup(destination);
  });

  it("counts a wrong code without consuming the challenge", async () => {
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
    });

    expect(await verifyChallenge({ challengeId, code: "000000" })).toEqual({
      ok: false,
      error: "CODE_INCORRECT",
    });

    const [row] = await db()
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId));
    expect(row?.attempts).toBe(1);

    // The real code still works: one typo must not end the attempt.
    expect((await verifyChallenge({ challengeId, code })).ok).toBe(true);

    await cleanup(destination);
  });

  it("locks the challenge on the sixth wrong attempt", async () => {
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
    });
    const wrong = code === "000000" ? "111111" : "000000";

    for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      expect(await verifyChallenge({ challengeId, code: wrong })).toEqual({
        ok: false,
        error: "CODE_INCORRECT",
      });
    }

    expect(await verifyChallenge({ challengeId, code: wrong })).toEqual({
      ok: false,
      error: "CHALLENGE_LOCKED",
    });

    // Locked means locked: the correct code no longer helps.
    expect(await verifyChallenge({ challengeId, code })).toEqual({
      ok: false,
      error: "CHALLENGE_LOCKED",
    });

    const [row] = await db()
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId));
    expect(row?.attempts).toBe(OTP_MAX_ATTEMPTS);
    expect(row?.lockedAt).toBeInstanceOf(Date);

    await cleanup(destination);
  });

  it("loses no attempts when guesses arrive in parallel", async () => {
    // The attempt counter is a security control, so the increment is done as
    // `attempts + 1` in SQL and cannot lose an update.
    //
    // Note on what this test does and does not prove: it did NOT fail when the
    // row lock was removed, because concurrent transactions on one pool do not
    // reliably interleave in a way that reproduces a lost update. It guards the
    // observable contract; the atomic increment is what makes the contract hold.
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
    });
    const wrong = code === "000000" ? "111111" : "000000";
    const parallelGuesses = 5;

    const results = await Promise.all(
      Array.from({ length: parallelGuesses }, () =>
        verifyChallenge({ challengeId, code: wrong }),
      ),
    );

    expect(results.every((result) => result.ok === false)).toBe(true);

    const [row] = await db()
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId));
    expect(row?.attempts).toBe(parallelGuesses);

    await cleanup(destination);
  });

  it("rejects a code after the challenge expires", async () => {
    const issuedAt = new Date("2026-07-29T12:00:00.000Z");
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
      now: issuedAt,
    });

    const justAfter = new Date(issuedAt.getTime() + OTP_TTL_MS + 1);
    expect(await verifyChallenge({ challengeId, code, now: justAfter })).toEqual({
      ok: false,
      error: "CHALLENGE_EXPIRED",
    });

    await cleanup(destination);
  });

  it("accepts a code at the last moment before expiry", async () => {
    const issuedAt = new Date("2026-07-29T12:00:00.000Z");
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
      now: issuedAt,
    });

    const justBefore = new Date(issuedAt.getTime() + OTP_TTL_MS - 1);
    expect(
      (await verifyChallenge({ challengeId, code, now: justBefore })).ok,
    ).toBe(true);

    await cleanup(destination);
  });

  it("reports a missing challenge without revealing whether one existed", async () => {
    expect(
      await verifyChallenge({ challengeId: randomUUID(), code: "123456" }),
    ).toEqual({ ok: false, error: "CHALLENGE_NOT_FOUND" });
  });

  it("rejects a code issued for a different destination", async () => {
    // The stored hash binds code to destination, so a code observed in one
    // inbox cannot be replayed against another person's challenge.
    const other = `otp-${randomUUID()}@example.test`;
    const mine = await createChallenge({ channel: "email", destination });
    const theirs = await createChallenge({ channel: "email", destination: other });

    expect(
      await verifyChallenge({ challengeId: mine.challengeId, code: theirs.code }),
    ).toEqual({ ok: false, error: "CODE_INCORRECT" });

    await cleanup(destination);
    await cleanup(other);
  });
});

describe("attempt log", () => {
  it("records outcomes without storing the destination in the clear", async () => {
    const { challengeId, code } = await createChallenge({
      channel: "email",
      destination,
    });

    await verifyChallenge({ challengeId, code: "000000" });
    await verifyChallenge({ challengeId, code });

    const attempts = await db()
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.challengeId, challengeId));

    expect(attempts).toHaveLength(2);
    expect(attempts.map((row) => row.succeeded).sort()).toEqual([false, true]);
    for (const attempt of attempts) {
      expect(attempt.destinationHash).not.toContain(destination);
      expect(attempt.destinationHash).toMatch(/^[0-9a-f]{64}$/);
    }

    await cleanup(destination);
  });

  it("never writes the submitted code into the log", async () => {
    const { challengeId } = await createChallenge({
      channel: "email",
      destination,
    });

    await verifyChallenge({ challengeId, code: "424242" });

    const [attempt] = await db()
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.challengeId, challengeId));

    expect(JSON.stringify(attempt)).not.toContain("424242");

    await cleanup(destination);
  });
});

describe("purgeExpiredChallenges", () => {
  it("removes only challenges that expired before the cutoff", async () => {
    const old = await createChallenge({
      channel: "email",
      destination,
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    const fresh = await createChallenge({ channel: "email", destination });

    await purgeExpiredChallenges(new Date("2021-01-01T00:00:00.000Z"));

    const remaining = await db()
      .select({ id: loginChallenges.id })
      .from(loginChallenges)
      .where(eq(loginChallenges.destination, destination));

    const ids = remaining.map((row) => row.id);
    expect(ids).not.toContain(old.challengeId);
    expect(ids).toContain(fresh.challengeId);

    await cleanup(destination);
  });
});
