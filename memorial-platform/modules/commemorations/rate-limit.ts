import { and, eq, gte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { commemorations } from "@/db/schema";

/**
 * Limits on how often one visitor may act.
 *
 * Counted in PostgreSQL against the commemorations already recorded, not in a
 * cache. The reasoning is the same as for login attempts: this is an abuse
 * control, and an eviction or a restart must not hand someone a fresh
 * allowance. It also needs no second datastore to be correct.
 *
 * Redis remains the right tool for generic per-request limiting across every
 * endpoint, where the volume is high and losing a counter is harmless. That is
 * a separate piece of work.
 */
export type RateLimitWindow = {
  windowMs: number;
  max: number;
};

/**
 * Deliberately generous. A large family sharing news of a death produces a
 * burst of genuine visits from one office or one household behind a single
 * address, and treating that as abuse would turn people away at the worst
 * possible moment. These stop automated flooding, not mourning.
 */
export const IP_LIMIT: RateLimitWindow = { windowMs: 60 * 60 * 1000, max: 60 };

export const ACCOUNT_LIMIT: RateLimitWindow = {
  windowMs: 60 * 60 * 1000,
  max: 60,
};

/** One person leaving the same memorial twenty offerings in an hour is spam. */
export const PER_MEMORIAL_LIMIT: RateLimitWindow = {
  windowMs: 60 * 60 * 1000,
  max: 20,
};

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; scope: "ip" | "account" | "memorial" };

async function countMatching(where: SQL | undefined): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(commemorations)
    .where(where);

  return row?.total ?? 0;
}

/**
 * Checks the windows that apply to this visitor.
 *
 * An anonymous visitor is limited by address alone, which is the only handle
 * available. A signed-in visitor is limited by account as well, so rotating
 * addresses does not multiply the allowance.
 */
export async function checkRateLimits(input: {
  memorialId: string;
  actorUserId: string | null;
  requestIpHash: string | null;
  now?: Date;
}): Promise<RateLimitDecision> {
  const now = input.now ?? new Date();

  if (input.requestIpHash) {
    const since = new Date(now.getTime() - IP_LIMIT.windowMs);
    const total = await countMatching(
      and(
        eq(commemorations.requestIpHash, input.requestIpHash),
        gte(commemorations.createdAt, since),
      ),
    );
    if (total >= IP_LIMIT.max) {
      return { allowed: false, scope: "ip" };
    }
  }

  if (input.actorUserId) {
    const since = new Date(now.getTime() - ACCOUNT_LIMIT.windowMs);
    const total = await countMatching(
      and(
        eq(commemorations.actorUserId, input.actorUserId),
        gte(commemorations.createdAt, since),
      ),
    );
    if (total >= ACCOUNT_LIMIT.max) {
      return { allowed: false, scope: "account" };
    }
  }

  // The per-memorial window needs something to attribute activity to. With
  // neither an account nor an address there is nothing to count against, and
  // counting every visitor's commemorations together would shut the memorial to
  // everyone once it became busy.
  const attribution = input.actorUserId
    ? eq(commemorations.actorUserId, input.actorUserId)
    : input.requestIpHash
      ? eq(commemorations.requestIpHash, input.requestIpHash)
      : null;

  if (attribution) {
    const since = new Date(now.getTime() - PER_MEMORIAL_LIMIT.windowMs);
    const perMemorial = await countMatching(
      and(
        eq(commemorations.memorialId, input.memorialId),
        gte(commemorations.createdAt, since),
        attribution,
      ),
    );

    if (perMemorial >= PER_MEMORIAL_LIMIT.max) {
      return { allowed: false, scope: "memorial" };
    }
  }

  return { allowed: true };
}
