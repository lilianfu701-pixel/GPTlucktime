import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  commemorationMessages,
  commemorations,
  memorials,
  outboxEvents,
  searchDocuments,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import { memorialRoleFor } from "./membership";

export type DeletionError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "CONFIRMATION_REQUIRED"
  | "OWNERSHIP_FROZEN"
  | "ALREADY_REQUESTED";

/**
 * How long a family has to change their mind.
 *
 * Thirty days is an engineering default; doc 11 section 2 leaves the real period
 * to the retention policy still to be written. It is generous on purpose:
 * deleting a memorial is the kind of decision made in the worst week of
 * someone's life, and the cost of holding data slightly longer is far smaller
 * than the cost of a family losing the only record of a relative.
 */
export const RECOVERY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Starts deleting a memorial.
 *
 * Two things happen straight away, and one happens later.
 *
 * Immediately: the memorial stops being reachable and stops appearing in
 * search. Both come from the row itself — the access decision and the search
 * query already read `deletionRequestedAt` — so nothing about a family's
 * decision waits on a worker.
 *
 * Later: the worker removes media, derivatives and the search document once the
 * recovery period has passed.
 */
export async function requestDeletion(
  actor: Actor,
  memorialId: string,
  input: { confirmed: boolean },
  correlationId: string,
): Promise<Result<{ purgeAfter: Date }, DeletionError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "request_deletion" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  // Never inferred from the request having been sent.
  if (!input.confirmed) {
    return err("CONFIRMATION_REQUIRED");
  }

  const [memorial] = await db()
    .select({
      id: memorials.id,
      deletionRequestedAt: memorials.deletionRequestedAt,
      ownershipFrozenAt: memorials.ownershipFrozenAt,
    })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (memorial.deletionRequestedAt) {
    return err("ALREADY_REQUESTED");
  }

  // Someone is contesting who manages this page. Deleting it would settle that
  // question by destroying what is being contested.
  if (memorial.ownershipFrozenAt) {
    return err("OWNERSHIP_FROZEN");
  }

  const now = new Date();
  const purgeAfter = new Date(now.getTime() + RECOVERY_PERIOD_MS);

  await db().transaction(async (tx) => {
    await tx
      .update(memorials)
      .set({
        status: "pending_deletion",
        deletionRequestedAt: now,
        purgeAfter,
      })
      .where(eq(memorials.id, memorialId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.deletion_requested",
      resourceType: "memorial",
      resourceId: memorialId,
      newValue: { purgeAfter: purgeAfter.toISOString() },
      correlationId,
    });

    await tx.insert(outboxEvents).values({
      topic: "search.remove",
      aggregateId: memorialId,
      payload: { memorialId, correlationId },
    });

    await tx.insert(outboxEvents).values({
      topic: "memorial.purge",
      aggregateId: memorialId,
      payload: { memorialId, purgeAfter: purgeAfter.toISOString(), correlationId },
    });
  });

  return ok({ purgeAfter });
}

/**
 * Cancels a deletion inside the recovery period.
 *
 * The whole point of the period. A family who asked in grief and changed their
 * mind two days later gets their relative's page back exactly as it was.
 */
export async function cancelDeletion(
  actor: Actor,
  memorialId: string,
  correlationId: string,
): Promise<Result<{ restored: true }, DeletionError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "request_deletion" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const [memorial] = await db()
    .select({ deletionRequestedAt: memorials.deletionRequestedAt })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial?.deletionRequestedAt) {
    return err("MEMORIAL_NOT_FOUND");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(memorials)
      .set({
        status: "published",
        deletionRequestedAt: null,
        purgeAfter: null,
      })
      .where(eq(memorials.id, memorialId));

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.deletion_cancelled",
      resourceType: "memorial",
      resourceId: memorialId,
      correlationId,
    });

    await tx.insert(outboxEvents).values({
      topic: "search.index",
      aggregateId: memorialId,
      payload: { memorialId, correlationId },
    });
  });

  return ok({ restored: true });
}

export type PurgeSummary = {
  memorialId: string;
  searchDocumentsRemoved: number;
  commemorationsPseudonymized: number;
};

/**
 * Finishes a deletion once the recovery period has passed.
 *
 * Commemorations are pseudonymized rather than deleted. Someone who came to
 * light a candle for a stranger's father performed an act of their own, and the
 * family's decision to remove the page is not a decision about that person's
 * account history. Detaching the visitor honours both: the memorial goes, and
 * nobody's record of having been there is rewritten as somebody else's.
 */
export async function purgeMemorial(
  memorialId: string,
  correlationId: string,
  now: Date = new Date(),
): Promise<Result<PurgeSummary, DeletionError>> {
  const [memorial] = await db()
    .select({
      id: memorials.id,
      purgeAfter: memorials.purgeAfter,
      deletionRequestedAt: memorials.deletionRequestedAt,
    })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!memorial?.deletionRequestedAt) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!memorial.purgeAfter || memorial.purgeAfter.getTime() > now.getTime()) {
    // Still inside the recovery period. Nothing is destroyed yet.
    return err("CONFIRMATION_REQUIRED");
  }

  const removedDocs = await db()
    .delete(searchDocuments)
    .where(eq(searchDocuments.memorialId, memorialId))
    .returning({ memorialId: searchDocuments.memorialId });

  const acts = await db()
    .select({ id: commemorations.id })
    .from(commemorations)
    .where(eq(commemorations.memorialId, memorialId));

  await db().transaction(async (tx) => {
    for (const act of acts) {
      await tx
        .update(commemorations)
        .set({ actorUserId: null, anonymous: true, requestIpHash: null })
        .where(eq(commemorations.id, act.id));

      await tx
        .update(commemorationMessages)
        .set({ moderationStatus: "hidden" })
        .where(eq(commemorationMessages.commemorationId, act.id));
    }

    await tx.insert(auditLogs).values({
      action: "memorial.purged",
      resourceType: "memorial",
      resourceId: memorialId,
      newValue: {
        searchDocumentsRemoved: removedDocs.length,
        commemorationsPseudonymized: acts.length,
      },
      correlationId,
    });

    // The media worker removes objects; the row is what tells it to.
    await tx.insert(outboxEvents).values({
      topic: "media.process",
      aggregateId: memorialId,
      payload: { memorialId, purge: true, correlationId },
    });
  });

  return ok({
    memorialId,
    searchDocumentsRemoved: removedDocs.length,
    commemorationsPseudonymized: acts.length,
  });
}

/** Memorials whose recovery period has run out. */
export async function memorialsDueForPurge(now: Date = new Date()): Promise<
  string[]
> {
  const rows = await db()
    .select({ id: memorials.id })
    .from(memorials)
    .where(
      and(
        isNotNull(memorials.deletionRequestedAt),
        isNotNull(memorials.purgeAfter),
        lte(memorials.purgeAfter, now),
      ),
    );

  return rows.map((row) => row.id);
}
