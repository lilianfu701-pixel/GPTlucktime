import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, memorials, recognitionClaims } from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import type { Actor } from "@/modules/permissions/types";
import { memorialRoleFor } from "./membership";
import { canOnMemorial } from "@/modules/permissions/policy";

export type RecognitionError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "FORBIDDEN"
  | "CLAIM_NOT_FOUND"
  | "ALREADY_CLAIMED"
  | "ALREADY_DECIDED"
  | "CANNOT_CLAIM_OWN_MEMORIAL";

type ClaimStatus = "pending" | "escalated" | "confirmed" | "rejected" | "withdrawn";

export async function createRecognitionClaim(
  actor: Actor,
  input: {
    memorialId: string;
    claimedName: string;
    claimedRelationship: string;
  },
  correlationId: string,
): Promise<Result<{ claimId: string }, RecognitionError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [memorial] = await db()
    .select({ id: memorials.id, ownerUserId: memorials.ownerUserId })
    .from(memorials)
    .where(eq(memorials.id, input.memorialId));

  if (!memorial) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (memorial.ownerUserId === actor.userId) {
    return err("CANNOT_CLAIM_OWN_MEMORIAL");
  }

  const [existing] = await db()
    .select({ id: recognitionClaims.id, status: recognitionClaims.status })
    .from(recognitionClaims)
    .where(
      and(
        eq(recognitionClaims.memorialId, input.memorialId),
        eq(recognitionClaims.claimantUserId, actor.userId),
        inArray(recognitionClaims.status, ["pending", "escalated"]),
      ),
    );

  if (existing) {
    return err("ALREADY_CLAIMED");
  }

  const [row] = await db()
    .insert(recognitionClaims)
    .values({
      memorialId: input.memorialId,
      claimantUserId: actor.userId,
      claimedName: input.claimedName,
      claimedRelationship: input.claimedRelationship,
    })
    .returning({ id: recognitionClaims.id });

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "recognition_claim.created",
    resourceType: "recognition_claim",
    resourceId: row!.id,
    newValue: {
      memorialId: input.memorialId,
      claimedName: input.claimedName,
      claimedRelationship: input.claimedRelationship,
    },
    correlationId,
  });

  return ok({ claimId: row!.id });
}

export async function decideRecognitionClaim(
  actor: Actor,
  claimId: string,
  decision: "confirmed" | "rejected",
  decisionNote: string | undefined,
  correlationId: string,
): Promise<Result<{ status: ClaimStatus }, RecognitionError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [claim] = await db()
    .select({
      id: recognitionClaims.id,
      memorialId: recognitionClaims.memorialId,
      status: recognitionClaims.status,
    })
    .from(recognitionClaims)
    .where(eq(recognitionClaims.id, claimId));

  if (!claim) {
    return err("CLAIM_NOT_FOUND");
  }

  if (claim.status !== "pending" && claim.status !== "escalated") {
    return err("ALREADY_DECIDED");
  }

  const role = await memorialRoleFor(claim.memorialId, actor.userId);
  if (!role || !canOnMemorial({ actor, role, action: "manage_family_links" })) {
    return err("FORBIDDEN");
  }

  const now = new Date();

  await db()
    .update(recognitionClaims)
    .set({
      status: decision,
      decidedByUserId: actor.userId,
      decidedAt: now,
      decisionNote: decisionNote ?? null,
    })
    .where(eq(recognitionClaims.id, claimId));

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: `recognition_claim.${decision}`,
    resourceType: "recognition_claim",
    resourceId: claimId,
    newValue: { status: decision, decisionNote: decisionNote ?? null },
    correlationId,
  });

  return ok({ status: decision });
}

export async function withdrawRecognitionClaim(
  actor: Actor,
  claimId: string,
  correlationId: string,
): Promise<Result<{ status: ClaimStatus }, RecognitionError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [claim] = await db()
    .select({
      id: recognitionClaims.id,
      claimantUserId: recognitionClaims.claimantUserId,
      status: recognitionClaims.status,
    })
    .from(recognitionClaims)
    .where(eq(recognitionClaims.id, claimId));

  if (!claim) {
    return err("CLAIM_NOT_FOUND");
  }

  if (claim.claimantUserId !== actor.userId) {
    return err("FORBIDDEN");
  }

  if (claim.status !== "pending" && claim.status !== "escalated") {
    return err("ALREADY_DECIDED");
  }

  await db()
    .update(recognitionClaims)
    .set({ status: "withdrawn" })
    .where(eq(recognitionClaims.id, claimId));

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "recognition_claim.withdrawn",
    resourceType: "recognition_claim",
    resourceId: claimId,
    newValue: { status: "withdrawn" },
    correlationId,
  });

  return ok({ status: "withdrawn" });
}

export async function escalateRecognitionClaim(
  claimId: string,
  correlationId: string,
): Promise<Result<{ status: ClaimStatus }, RecognitionError>> {
  const [claim] = await db()
    .select({
      id: recognitionClaims.id,
      status: recognitionClaims.status,
    })
    .from(recognitionClaims)
    .where(eq(recognitionClaims.id, claimId));

  if (!claim) {
    return err("CLAIM_NOT_FOUND");
  }

  if (claim.status !== "pending") {
    return err("ALREADY_DECIDED");
  }

  const now = new Date();

  await db()
    .update(recognitionClaims)
    .set({ status: "escalated", escalatedAt: now })
    .where(eq(recognitionClaims.id, claimId));

  await db().insert(auditLogs).values({
    actorUserId: null,
    action: "recognition_claim.escalated",
    resourceType: "recognition_claim",
    resourceId: claimId,
    newValue: { status: "escalated" },
    correlationId,
  });

  return ok({ status: "escalated" });
}

export async function listPendingClaims(
  actor: Actor,
  memorialId: string,
): Promise<Result<{ claims: Array<typeof recognitionClaims.$inferSelect> }, RecognitionError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  if (!role || !canOnMemorial({ actor, role, action: "manage_family_links" })) {
    return err("FORBIDDEN");
  }

  const claims = await db()
    .select()
    .from(recognitionClaims)
    .where(
      and(
        eq(recognitionClaims.memorialId, memorialId),
        inArray(recognitionClaims.status, ["pending", "escalated"]),
      ),
    );

  return ok({ claims });
}
