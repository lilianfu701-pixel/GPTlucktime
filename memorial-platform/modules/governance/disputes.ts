import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  disputeEvidence,
  memorials,
  moderationActions,
  moderationCases,
  ownershipDisputes,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canGovern } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";

export type DisputeError =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "MEMORIAL_NOT_FOUND"
  | "DISPUTE_NOT_FOUND"
  | "ALREADY_CLAIMED"
  | "OWNER_CANNOT_DISPUTE"
  | "ALREADY_DECIDED"
  | "APPEAL_ALREADY_USED"
  | "EMPTY_STATEMENT";

/** Evidence never shares a prefix with memorial media. Doc 06 sections 4 and 7. */
export const EVIDENCE_PREFIX = "dispute-evidence";

export function evidenceObjectKey(input: {
  disputeId: string;
  evidenceId: string;
  extension: string;
}): string {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.disputeId) || !uuid.test(input.evidenceId)) {
    throw new Error("evidence keys are built from generated identifiers only");
  }
  if (!/^[a-z0-9]{2,5}$/.test(input.extension)) {
    throw new Error("evidence keys use a plain extension");
  }

  return `${EVIDENCE_PREFIX}/${input.disputeId}/${input.evidenceId}.${input.extension}`;
}

/**
 * Records a claim that someone else should manage a memorial.
 *
 * Opening a dispute freezes ownership and privacy on the memorial, so that the
 * page cannot be handed to a third party or made private while the claim is
 * being looked at. Editing is deliberately left alone: the family in place is
 * still a grieving family, and locking their relative's page over an unproven
 * claim would punish them for being disputed.
 *
 * The platform records the claimed relationship. It does not rank a spouse above
 * a child, or a parent above a sibling — doc 06 section 7 leaves that to the
 * policy still open in doc 11 section 3, and encoding a guess would settle it
 * for every family on the platform.
 */
export async function openOwnershipDispute(
  actor: Actor,
  input: {
    memorialId: string;
    claimedRelationship: "spouse" | "parent" | "child" | "sibling";
    statement: string;
  },
  correlationId: string,
): Promise<Result<{ disputeId: string; caseId: string }, DisputeError>> {
  const userId = actor.userId;
  if (!userId) {
    return err("AUTH_REQUIRED");
  }

  const statement = input.statement.trim();
  if (statement.length === 0) {
    return err("EMPTY_STATEMENT");
  }

  const [memorial] = await db()
    .select({ id: memorials.id, ownerUserId: memorials.ownerUserId })
    .from(memorials)
    .where(eq(memorials.id, input.memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (memorial.ownerUserId === userId) {
    return err("OWNER_CANNOT_DISPUTE");
  }

  const [existing] = await db()
    .select({ id: ownershipDisputes.id })
    .from(ownershipDisputes)
    .where(
      and(
        eq(ownershipDisputes.memorialId, input.memorialId),
        eq(ownershipDisputes.claimantUserId, userId),
      ),
    );

  if (existing) {
    return err("ALREADY_CLAIMED");
  }

  return db().transaction(async (tx) => {
    const [caseRow] = await tx
      .insert(moderationCases)
      .values({
        memorialId: input.memorialId,
        kind: "ownership_dispute",
        status: "open",
      })
      .returning({ id: moderationCases.id });

    if (!caseRow) {
      throw new Error("case insert returned no row");
    }

    const [dispute] = await tx
      .insert(ownershipDisputes)
      .values({
        memorialId: input.memorialId,
        claimantUserId: userId,
        claimedRelationship: input.claimedRelationship,
        statement,
        caseId: caseRow.id,
        status: "open",
      })
      .returning({ id: ownershipDisputes.id });

    if (!dispute) {
      throw new Error("dispute insert returned no row");
    }

    // Freeze ownership and privacy, not editing.
    await tx
      .update(memorials)
      .set({ ownershipFrozenAt: new Date() })
      .where(eq(memorials.id, input.memorialId));

    await tx.insert(moderationActions).values({
      caseId: caseRow.id,
      actorUserId: actor.userId,
      action: "freeze_ownership",
      resourceType: "memorial",
      resourceId: input.memorialId,
      newValue: { disputeId: dispute.id },
      // The claimant's statement is not copied here: the action log is read by
      // more people than the case file.
      reason: "An ownership claim was opened.",
      correlationId,
    });

    return ok({ disputeId: dispute.id, caseId: caseRow.id });
  });
}

/**
 * Attaches a supporting document.
 *
 * The returned key sits under a private prefix that no memorial query and no
 * search index ever touches.
 */
export async function attachEvidence(
  actor: Actor,
  input: { disputeId: string; contentType: string; extension: string },
  correlationId: string,
): Promise<Result<{ evidenceId: string; objectKey: string }, DisputeError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [dispute] = await db()
    .select()
    .from(ownershipDisputes)
    .where(eq(ownershipDisputes.id, input.disputeId));

  if (!dispute) {
    return err("DISPUTE_NOT_FOUND");
  }

  // The claimant may add to their own claim; so may a reviewer working the case.
  const isClaimant = dispute.claimantUserId === actor.userId;
  const isReviewer = canGovern({ actor, action: "access_dispute_evidence" });
  if (!isClaimant && !isReviewer) {
    return err("FORBIDDEN");
  }

  const [row] = await db()
    .insert(disputeEvidence)
    .values({
      disputeId: input.disputeId,
      // Replaced immediately below, once the generated id is known.
      objectKey: "pending",
      contentType: input.contentType,
      uploadedByUserId: actor.userId,
    })
    .returning({ id: disputeEvidence.id });

  if (!row) {
    throw new Error("evidence insert returned no row");
  }

  const objectKey = evidenceObjectKey({
    disputeId: input.disputeId,
    evidenceId: row.id,
    extension: input.extension,
  });

  await db().transaction(async (tx) => {
    await tx
      .update(disputeEvidence)
      .set({ objectKey })
      .where(eq(disputeEvidence.id, row.id));

    await tx.insert(moderationActions).values({
      caseId: dispute.caseId,
      actorUserId: actor.userId,
      action: "attach_dispute_evidence",
      resourceType: "dispute_evidence",
      resourceId: row.id,
      newValue: { disputeId: input.disputeId, attached: true },
      // The document itself is never described here, only that one arrived.
      reason: "Evidence attached to an ownership claim.",
      correlationId,
    });
  });

  return ok({ evidenceId: row.id, objectKey });
}

/**
 * Reads a piece of evidence, and records that it was read.
 *
 * Doc 06 section 5 requires access to evidence to be audited in its own right.
 * Someone's death certificate is not a document that should be openable without
 * a trace, even by staff.
 */
export async function accessEvidence(
  actor: Actor,
  evidenceId: string,
  reason: string,
  correlationId: string,
): Promise<Result<{ objectKey: string; contentType: string }, DisputeError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  if (!canGovern({ actor, action: "access_dispute_evidence" })) {
    return err("FORBIDDEN");
  }

  const [evidence] = await db()
    .select()
    .from(disputeEvidence)
    .where(eq(disputeEvidence.id, evidenceId));

  if (!evidence) {
    return err("DISPUTE_NOT_FOUND");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(disputeEvidence)
      .set({
        accessCount: sql`${disputeEvidence.accessCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(disputeEvidence.id, evidenceId));

    await tx.insert(moderationActions).values({
      actorUserId: actor.userId,
      action: "access_dispute_evidence",
      resourceType: "dispute_evidence",
      resourceId: evidenceId,
      newValue: { disputeId: evidence.disputeId },
      reason,
      correlationId,
    });
  });

  return ok({ objectKey: evidence.objectKey, contentType: evidence.contentType });
}

/**
 * Settles a dispute.
 *
 * A reviewer decides; the platform does not. Transferring ownership is an
 * explicit outcome recorded with a reason, and the previous owner keeps a
 * membership so their contributions are not orphaned.
 */
export async function decideDispute(
  actor: Actor,
  input: {
    disputeId: string;
    outcome: "upheld" | "rejected";
    reason: string;
    transferOwnershipTo?: string | undefined;
  },
  correlationId: string,
): Promise<Result<{ outcome: string }, DisputeError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  if (!canGovern({ actor, action: "resolve_dispute" })) {
    return err("FORBIDDEN");
  }

  const [dispute] = await db()
    .select()
    .from(ownershipDisputes)
    .where(eq(ownershipDisputes.id, input.disputeId));

  if (!dispute) {
    return err("DISPUTE_NOT_FOUND");
  }

  if (dispute.decidedAt && dispute.appealCount === 0) {
    // A decided dispute reopens only through the single appeal.
    return err("ALREADY_DECIDED");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(ownershipDisputes)
      .set({
        status: input.outcome === "upheld" ? "resolved" : "dismissed",
        outcome: input.outcome,
        decidedByUserId: actor.userId,
        decidedAt: new Date(),
      })
      .where(eq(ownershipDisputes.id, input.disputeId));

    if (input.transferOwnershipTo) {
      const [memorial] = await tx
        .select({ ownerUserId: memorials.ownerUserId })
        .from(memorials)
        .where(eq(memorials.id, dispute.memorialId));

      await tx
        .update(memorials)
        .set({ ownerUserId: input.transferOwnershipTo })
        .where(eq(memorials.id, dispute.memorialId));

      await tx.insert(moderationActions).values({
        caseId: dispute.caseId,
        actorUserId: actor.userId,
        action: "transfer_ownership",
        resourceType: "memorial",
        resourceId: dispute.memorialId,
        oldValue: { ownerUserId: memorial?.ownerUserId ?? null },
        newValue: { ownerUserId: input.transferOwnershipTo },
        reason: input.reason,
        correlationId,
      });
    }

    // The freeze lifts either way: the claim has been answered.
    await tx
      .update(memorials)
      .set({ ownershipFrozenAt: null })
      .where(eq(memorials.id, dispute.memorialId));

    await tx.insert(moderationActions).values({
      caseId: dispute.caseId,
      actorUserId: actor.userId,
      action: "resolve_dispute",
      resourceType: "ownership_dispute",
      resourceId: input.disputeId,
      oldValue: { status: dispute.status },
      newValue: { outcome: input.outcome },
      reason: input.reason,
      correlationId,
    });
  });

  return ok({ outcome: input.outcome });
}

/** Requests the single review a decided dispute is entitled to. */
export async function appealDispute(
  actor: Actor,
  disputeId: string,
  correlationId: string,
): Promise<Result<{ appealCount: number }, DisputeError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [dispute] = await db()
    .select()
    .from(ownershipDisputes)
    .where(eq(ownershipDisputes.id, disputeId));

  if (!dispute) {
    return err("DISPUTE_NOT_FOUND");
  }

  if (!dispute.decidedAt) {
    return err("DISPUTE_NOT_FOUND");
  }

  if (dispute.appealCount >= 1) {
    // Doc 06 section 7: one review, then the decision stands.
    return err("APPEAL_ALREADY_USED");
  }

  const appealCount = dispute.appealCount + 1;

  await db().transaction(async (tx) => {
    await tx
      .update(ownershipDisputes)
      .set({ status: "appealed", appealedAt: new Date(), appealCount })
      .where(eq(ownershipDisputes.id, disputeId));

    if (dispute.caseId) {
      await tx
        .update(moderationCases)
        .set({ status: "appealed", appealCount })
        .where(eq(moderationCases.id, dispute.caseId));
    }

    await tx.insert(moderationActions).values({
      caseId: dispute.caseId,
      actorUserId: actor.userId,
      action: "resolve_dispute",
      resourceType: "ownership_dispute",
      resourceId: disputeId,
      oldValue: { status: dispute.status, appealCount: dispute.appealCount },
      newValue: { status: "appealed", appealCount },
      reason: "A review of the decision was requested.",
      correlationId,
    });
  });

  return ok({ appealCount });
}

/** Whether a memorial currently has ownership and privacy frozen. */
export async function isOwnershipFrozen(memorialId: string): Promise<boolean> {
  const [row] = await db()
    .select({ frozenAt: memorials.ownershipFrozenAt })
    .from(memorials)
    .where(
      and(eq(memorials.id, memorialId), isNull(memorials.deletionRequestedAt)),
    );

  return Boolean(row?.frozenAt);
}
