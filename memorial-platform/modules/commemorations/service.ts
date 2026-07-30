import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  blockedUsers,
  commemorationMessages,
  commemorations,
  outboxEvents,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { resolveAccessById } from "@/modules/memorials/access";
import { enabledRituals } from "@/modules/religion/memorial-settings";
import type { Actor } from "@/modules/permissions/types";
import { checkRateLimits } from "./rate-limit";

export type CommemorationError =
  | "MEMORIAL_NOT_FOUND"
  | "RITUAL_NOT_ENABLED"
  | "AUTH_REQUIRED"
  | "ANONYMOUS_NOT_ALLOWED"
  | "MESSAGE_NOT_ALLOWED"
  | "EMPTY_MESSAGE"
  | "BLOCKED"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_CONFLICT";

export type CommemorationInput = {
  memorialId: string;
  ritualVersionId: string;
  message?: string | undefined;
  locale: string;
  /** A signed-in visitor asking not to be named. */
  anonymous?: boolean | undefined;
};

export type CommemorationResult = {
  id: string;
  status: "visible" | "pending_review";
  created: boolean;
};

/**
 * Records that someone came.
 *
 * The order of the checks is deliberate. Access comes first, so a memorial the
 * caller may not see answers the same way whether or not the ritual exists.
 * Everything after that is about what the family permitted, and none of it is
 * inferred: a ritual absent from their settings cannot be performed even if the
 * catalogue published it.
 */
export async function createCommemoration(
  actor: Actor,
  input: CommemorationInput,
  idempotencyKey: string,
  context: { requestIpHash?: string | undefined },
  correlationId: string,
): Promise<Result<CommemorationResult, CommemorationError>> {
  const access = await resolveAccessById(input.memorialId, actor);
  if (!access.allowed) {
    // Includes the invite-only case, which must be indistinguishable from a
    // memorial that does not exist.
    return err("MEMORIAL_NOT_FOUND");
  }

  if (actor.userId) {
    const blocked = await isBlocked(input.memorialId, actor.userId);
    if (blocked) {
      // The caller can already see the memorial, so saying this leaks nothing
      // about its existence, and silence would be crueller than an answer.
      return err("BLOCKED");
    }
  }

  const setting = (await enabledRituals(input.memorialId)).find(
    (candidate) => candidate.ritualVersionId === input.ritualVersionId,
  );

  if (!setting) {
    return err("RITUAL_NOT_ENABLED");
  }

  const wantsAnonymous = input.anonymous === true;
  const isSignedIn = actor.userId !== null;

  // Acting without signing in is itself anonymous, so the family's setting has
  // to cover both cases rather than only the checkbox.
  if (!isSignedIn && !setting.allowAnonymous) {
    return err("AUTH_REQUIRED");
  }

  if (wantsAnonymous && !setting.allowAnonymous) {
    return err("ANONYMOUS_NOT_ALLOWED");
  }

  const message = input.message?.trim();
  if (message !== undefined && message.length > 0 && !setting.allowMessage) {
    return err("MESSAGE_NOT_ALLOWED");
  }

  if (input.message !== undefined && (message === undefined || message.length === 0)) {
    return err("EMPTY_MESSAGE");
  }

  const requestHash = hashRequest({
    ritualVersionId: input.ritualVersionId,
    message: message ?? null,
    anonymous: wantsAnonymous,
    locale: input.locale,
  });

  const existing = await findByIdempotencyKey(input.memorialId, idempotencyKey);
  if (existing) {
    // A retry of the same act returns the same record. The same key carrying a
    // different act is a conflict, not something to quietly accept.
    if (existing.requestHash !== requestHash) {
      return err("IDEMPOTENCY_CONFLICT");
    }
    return ok({
      id: existing.id,
      status: existing.status === "pending_review" ? "pending_review" : "visible",
      created: false,
    });
  }

  const limit = await checkRateLimits({
    memorialId: input.memorialId,
    actorUserId: actor.userId,
    requestIpHash: context.requestIpHash ?? null,
  });

  if (!limit.allowed) {
    return err("RATE_LIMITED");
  }

  // The act and the words are moderated separately: a family may want the
  // flowers to appear at once while reading the message first.
  const hasMessage = message !== undefined && message.length > 0;
  const messageNeedsReview =
    hasMessage && setting.moderationMode === "pre_review";
  const status: "visible" | "pending_review" = messageNeedsReview
    ? "pending_review"
    : "visible";

  const created = await db()
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(commemorations)
        .values({
          memorialId: input.memorialId,
          ritualVersionId: input.ritualVersionId,
          actorUserId: actor.userId,
          anonymous: wantsAnonymous || !isSignedIn,
          locale: input.locale,
          status,
          idempotencyKey,
          requestHash,
          requestIpHash: context.requestIpHash ?? null,
        })
        .returning({ id: commemorations.id });

      if (!row) {
        throw new Error("commemoration insert returned no row");
      }

      if (hasMessage) {
        await tx.insert(commemorationMessages).values({
          commemorationId: row.id,
          body: message,
          sourceLocale: input.locale,
          moderationStatus: messageNeedsReview ? "pending_review" : "visible",
        });
      }

      // Written in the same transaction, delivered later. A mail provider being
      // down must not undo someone's act of remembrance.
      await tx.insert(outboxEvents).values({
        topic: "commemoration.created",
        aggregateId: input.memorialId,
        payload: {
          commemorationId: row.id,
          memorialId: input.memorialId,
          hasMessage,
          correlationId,
        },
      });

      return { id: row.id, status, created: true };
    })
    .catch(async (error: unknown) => {
      // Two retries racing: the loser of the unique index returns the winner's
      // record rather than an error.
      if (isUniqueViolation(error)) {
        const raced = await findByIdempotencyKey(input.memorialId, idempotencyKey);
        if (raced) {
          if (raced.requestHash !== requestHash) {
            return null;
          }
          return {
            id: raced.id,
            status:
              raced.status === "pending_review"
                ? ("pending_review" as const)
                : ("visible" as const),
            created: false,
          };
        }
      }
      throw error;
    });

  if (!created) {
    return err("IDEMPOTENCY_CONFLICT");
  }

  return ok(created);
}

/**
 * How many times visitors have come.
 *
 * Counts only what is visible and not withdrawn. Used to show a family that
 * people came; never to compare one memorial with another, which doc 01
 * section 4.3 rules out.
 */
export async function visibleCommemorationCount(
  memorialId: string,
): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(commemorations)
    .where(
      and(
        eq(commemorations.memorialId, memorialId),
        eq(commemorations.status, "visible"),
        isNull(commemorations.deletedAt),
      ),
    );

  return row?.total ?? 0;
}

/** Messages a public reader may see. */
export async function visibleMessages(
  memorialId: string,
): Promise<{ commemorationId: string; body: string }[]> {
  return db()
    .select({
      commemorationId: commemorationMessages.commemorationId,
      body: commemorationMessages.body,
    })
    .from(commemorationMessages)
    .innerJoin(
      commemorations,
      eq(commemorations.id, commemorationMessages.commemorationId),
    )
    .where(
      and(
        eq(commemorations.memorialId, memorialId),
        eq(commemorationMessages.moderationStatus, "visible"),
        isNull(commemorations.deletedAt),
      ),
    );
}

async function isBlocked(memorialId: string, userId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: blockedUsers.id })
    .from(blockedUsers)
    .where(
      and(
        eq(blockedUsers.memorialId, memorialId),
        eq(blockedUsers.blockedUserId, userId),
        isNull(blockedUsers.liftedAt),
      ),
    );

  return row !== undefined;
}

async function findByIdempotencyKey(
  memorialId: string,
  idempotencyKey: string,
): Promise<{ id: string; status: string; requestHash: string } | null> {
  const [row] = await db()
    .select({
      id: commemorations.id,
      status: commemorations.status,
      requestHash: commemorations.requestHash,
    })
    .from(commemorations)
    .where(
      and(
        eq(commemorations.memorialId, memorialId),
        eq(commemorations.idempotencyKey, idempotencyKey),
      ),
    );

  return row ?? null;
}

/**
 * Fingerprints the meaningful parts of a request.
 *
 * Unkeyed on purpose: this is not a secret, only a way to notice that the same
 * key arrived carrying something different.
 */
function hashRequest(input: {
  ritualVersionId: string;
  message: string | null;
  anonymous: boolean;
  locale: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.ritualVersionId,
        input.message,
        input.anonymous,
        input.locale,
      ]),
    )
    .digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
