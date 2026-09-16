import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  emailCredentials,
  memorialMembers,
  memorialNames,
  memorialTakeoverRequests,
  memorials,
  users,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import type { Actor } from "@/modules/permissions/types";
import { notify } from "@/modules/messaging/inbox";
import { openOwnershipDispute } from "@/modules/governance/disputes";

/** How long the current admin has to respond before a takeover may escalate. */
export const TAKEOVER_GRACE_DAYS = 30;
const GRACE_MS = TAKEOVER_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** The relationships an escalation can carry into a formal ownership dispute. */
export type TakeoverRelationship = "spouse" | "parent" | "child" | "sibling";

export type OwnershipError =
  | "AUTH_REQUIRED"
  | "NOT_OWNER"
  | "NOT_REQUESTER"
  | "MEMORIAL_NOT_FOUND"
  | "TARGET_NOT_REGISTERED"
  | "SELF"
  | "OWNER_CANNOT_REQUEST"
  | "EMPTY_REASON"
  | "ALREADY_REQUESTED"
  | "REQUEST_NOT_FOUND"
  | "NOT_PENDING"
  | "TOO_SOON"
  | "FORBIDDEN";

async function memorialOwner(memorialId: string): Promise<string | null> {
  const [row] = await db()
    .select({ owner: memorials.ownerUserId })
    .from(memorials)
    .where(eq(memorials.id, memorialId));
  return row?.owner ?? null;
}

async function memorialPrimaryName(memorialId: string): Promise<string> {
  const [row] = await db()
    .select({ v: memorialNames.value })
    .from(memorialNames)
    .where(
      and(
        eq(memorialNames.memorialId, memorialId),
        eq(memorialNames.type, "primary"),
      ),
    );
  return row?.v ?? "";
}

async function userDisplayName(userId: string): Promise<string> {
  const [u] = await db()
    .select({ d: users.displayName, f: users.fullName })
    .from(users)
    .where(eq(users.id, userId));
  return u?.d ?? u?.f ?? "";
}

/** The admin (owner) shown on the public page — their display name, or null. */
export async function getMemorialAdminName(
  memorialId: string,
): Promise<string | null> {
  const owner = await memorialOwner(memorialId);
  if (!owner) return null;
  const name = await userDisplayName(owner);
  return name || null;
}

/**
 * Moves ownership from one account to another: the new owner's membership
 * becomes `owner`, the previous owner stays on as an `admin` rather than being
 * dropped, so a mistaken transfer can be undone by the new owner.
 */
async function applyTransfer(
  memorialId: string,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .update(memorials)
      // Ownership passing to a family member ends any platform stewardship, so
      // the paid offerings reopen the moment the page is claimed.
      .set({ ownerUserId: toUserId, stewardedByAdminAt: null })
      .where(eq(memorials.id, memorialId));

    await tx
      .insert(memorialMembers)
      .values({
        memorialId,
        userId: toUserId,
        role: "owner",
        acceptedAt: new Date(),
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: [memorialMembers.memorialId, memorialMembers.userId],
        set: { role: "owner", acceptedAt: new Date(), revokedAt: null },
      });

    await tx
      .update(memorialMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(memorialMembers.memorialId, memorialId),
          eq(memorialMembers.userId, fromUserId),
        ),
      );
  });
}

async function notifyTransfer(
  memorialId: string,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  const name = await memorialPrimaryName(memorialId);
  await notify({
    recipientUserId: toUserId,
    memorialId,
    subject: name,
    body: `你已成为「${name}」追思页的管理员。`,
    templateKey: "ownershipReceived",
    templateParams: { name },
  });
  await notify({
    recipientUserId: fromUserId,
    memorialId,
    subject: name,
    body: `你已将「${name}」追思页的管理权转让给他人。`,
    templateKey: "ownershipHandedOver",
    templateParams: { name },
  });
}

/** Owner-initiated transfer to another registered account, by email. */
export async function transferOwnership(
  actor: Actor,
  memorialId: string,
  targetEmail: string,
  correlationId: string,
): Promise<Result<{ transferred: true }, OwnershipError>> {
  if (!actor.userId) return err("AUTH_REQUIRED");

  const owner = await memorialOwner(memorialId);
  if (owner === null) return err("MEMORIAL_NOT_FOUND");
  if (owner !== actor.userId) return err("NOT_OWNER");

  const email = targetEmail.toLowerCase().trim();
  const [cred] = await db()
    .select({ userId: emailCredentials.userId })
    .from(emailCredentials)
    .where(eq(emailCredentials.email, email));
  if (!cred) return err("TARGET_NOT_REGISTERED");
  if (cred.userId === actor.userId) return err("SELF");

  await applyTransfer(memorialId, actor.userId, cred.userId);

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "memorial.ownership_transferred",
    resourceType: "memorial",
    resourceId: memorialId,
    newValue: { toUserId: cred.userId },
    correlationId,
  });

  await notifyTransfer(memorialId, actor.userId, cred.userId);
  return ok({ transferred: true });
}

/** Adds someone as an editor (co-manager who can contribute), without changing
 *  ownership. Used when the owner accepts a `join` request. */
async function addAsEditor(memorialId: string, userId: string): Promise<void> {
  await db()
    .insert(memorialMembers)
    .values({
      memorialId,
      userId,
      role: "editor",
      acceptedAt: new Date(),
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: [memorialMembers.memorialId, memorialMembers.userId],
      set: { role: "editor", acceptedAt: new Date(), revokedAt: null },
    });
}

/**
 * Platform override: a super admin takes management of any memorial at will,
 * with no request or grace period. Ownership passes to the admin and the former
 * owner is kept on as an admin-role member (never removed), and notified.
 */
export async function adminReclaimMemorial(
  actor: Actor,
  memorialId: string,
  correlationId: string,
): Promise<Result<{ reclaimed: true }, OwnershipError>> {
  if (!actor.userId) return err("AUTH_REQUIRED");
  if (actor.platformRole !== "super_admin") return err("FORBIDDEN");

  const owner = await memorialOwner(memorialId);
  if (owner === null) return err("MEMORIAL_NOT_FOUND");
  if (owner === actor.userId) return ok({ reclaimed: true });

  await applyTransfer(memorialId, owner, actor.userId);

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "memorial.admin_reclaimed",
    resourceType: "memorial",
    resourceId: memorialId,
    newValue: { fromUserId: owner },
    correlationId,
  });

  const memName = await memorialPrimaryName(memorialId);
  await notify({
    recipientUserId: owner,
    memorialId,
    subject: memName,
    body: `平台管理员已收回「${memName}」追思页的管理权。`,
    templateKey: "adminReclaimed",
    templateParams: { name: memName },
  });

  return ok({ reclaimed: true });
}

/** A registered non-owner asks to take over an unreachable admin's page. */
export async function requestTakeover(
  actor: Actor,
  memorialId: string,
  input: {
    relationship: TakeoverRelationship;
    reason: string;
    kind?: "takeover" | "join";
  },
  correlationId: string,
): Promise<Result<{ requestId: string }, OwnershipError>> {
  if (!actor.userId) return err("AUTH_REQUIRED");
  const reason = input.reason.trim();
  if (reason.length === 0) return err("EMPTY_REASON");
  const kind = input.kind ?? "takeover";

  const owner = await memorialOwner(memorialId);
  if (owner === null) return err("MEMORIAL_NOT_FOUND");
  if (owner === actor.userId) return err("OWNER_CANNOT_REQUEST");

  const [existing] = await db()
    .select({ id: memorialTakeoverRequests.id })
    .from(memorialTakeoverRequests)
    .where(
      and(
        eq(memorialTakeoverRequests.memorialId, memorialId),
        eq(memorialTakeoverRequests.requesterUserId, actor.userId),
      ),
    );
  if (existing) return err("ALREADY_REQUESTED");

  const [row] = await db()
    .insert(memorialTakeoverRequests)
    .values({
      memorialId,
      requesterUserId: actor.userId,
      kind,
      relationship: input.relationship,
      reason: reason.slice(0, 2000),
      status: "pending",
    })
    .returning({ id: memorialTakeoverRequests.id });
  if (!row) throw new Error("takeover insert returned no row");

  const requesterName = await userDisplayName(actor.userId);
  const memName = await memorialPrimaryName(memorialId);
  await notify({
    recipientUserId: owner,
    memorialId,
    subject: memName,
    body:
      kind === "join"
        ? `${requesterName} 申请参与管理「${memName}」追思页，请到管理页回应。`
        : `${requesterName} 申请接管「${memName}」追思页。请在 ${TAKEOVER_GRACE_DAYS} 天内到管理页回应，否则对方可提交平台仲裁。`,
    templateKey: kind === "join" ? "joinRequested" : "takeoverRequested",
    templateParams: { name: requesterName, days: String(TAKEOVER_GRACE_DAYS) },
  });

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "memorial.takeover_requested",
    resourceType: "memorial",
    resourceId: memorialId,
    newValue: { requestId: row.id },
    correlationId,
  });

  return ok({ requestId: row.id });
}

/** The current owner accepts (transfers) or declines a takeover request. */
export async function respondToTakeover(
  actor: Actor,
  requestId: string,
  decision: "accept" | "decline",
  correlationId: string,
): Promise<Result<{ status: "accepted" | "declined" }, OwnershipError>> {
  if (!actor.userId) return err("AUTH_REQUIRED");

  const [req] = await db()
    .select({
      id: memorialTakeoverRequests.id,
      memorialId: memorialTakeoverRequests.memorialId,
      requester: memorialTakeoverRequests.requesterUserId,
      kind: memorialTakeoverRequests.kind,
      status: memorialTakeoverRequests.status,
    })
    .from(memorialTakeoverRequests)
    .where(eq(memorialTakeoverRequests.id, requestId));
  if (!req) return err("REQUEST_NOT_FOUND");

  const owner = await memorialOwner(req.memorialId);
  if (owner === null) return err("MEMORIAL_NOT_FOUND");
  // The owner answers their own requests; a super-admin also answers any, so a
  // claim on a platform-stewarded seed page (owned by a bot) can be approved.
  const isSuperAdmin = actor.platformRole === "super_admin";
  if (owner !== actor.userId && !isSuperAdmin) return err("NOT_OWNER");
  if (req.status !== "pending") return err("NOT_PENDING");

  const memName = await memorialPrimaryName(req.memorialId);
  const isJoin = req.kind === "join";

  if (decision === "accept") {
    // A join adds the requester as an editor; a takeover hands over ownership.
    if (isJoin) {
      await addAsEditor(req.memorialId, req.requester);
    } else {
      // Ownership passes from the current owner (the steward on a seed page), not
      // from whoever approved it.
      await applyTransfer(req.memorialId, owner, req.requester);
    }
    await db()
      .update(memorialTakeoverRequests)
      .set({
        status: "accepted",
        respondedByUserId: actor.userId,
        respondedAt: new Date(),
      })
      .where(eq(memorialTakeoverRequests.id, requestId));
    if (isJoin) {
      await notify({
        recipientUserId: req.requester,
        memorialId: req.memorialId,
        subject: memName,
        body: `你已成为「${memName}」追思页的共同管理者。`,
        templateKey: "joinAccepted",
        templateParams: { name: memName },
      });
    } else {
      await notifyTransfer(req.memorialId, owner, req.requester);
    }
    await db().insert(auditLogs).values({
      actorUserId: actor.userId,
      action: isJoin ? "memorial.join_accepted" : "memorial.takeover_accepted",
      resourceType: "memorial",
      resourceId: req.memorialId,
      newValue: { requestId, toUserId: req.requester },
      correlationId,
    });
    return ok({ status: "accepted" });
  }

  await db()
    .update(memorialTakeoverRequests)
    .set({
      status: "declined",
      respondedByUserId: actor.userId,
      respondedAt: new Date(),
    })
    .where(eq(memorialTakeoverRequests.id, requestId));
  await notify({
    recipientUserId: req.requester,
    memorialId: req.memorialId,
    subject: memName,
    body: isJoin
      ? `你对「${memName}」追思页的参与申请被婉拒。`
      : `你对「${memName}」追思页的接管申请被婉拒。`,
    templateKey: isJoin ? "joinDeclined" : "takeoverDeclined",
    templateParams: { name: memName },
  });
  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "memorial.takeover_declined",
    resourceType: "memorial",
    resourceId: req.memorialId,
    newValue: { requestId },
    correlationId,
  });
  return ok({ status: "declined" });
}

/**
 * The requester escalates a request the admin never answered into a formal,
 * platform-arbitrated ownership dispute — only after the grace period.
 */
export async function escalateTakeover(
  actor: Actor,
  requestId: string,
  correlationId: string,
): Promise<Result<{ disputeId: string }, OwnershipError>> {
  if (!actor.userId) return err("AUTH_REQUIRED");

  const [req] = await db()
    .select({
      memorialId: memorialTakeoverRequests.memorialId,
      requester: memorialTakeoverRequests.requesterUserId,
      kind: memorialTakeoverRequests.kind,
      relationship: memorialTakeoverRequests.relationship,
      reason: memorialTakeoverRequests.reason,
      status: memorialTakeoverRequests.status,
      createdAt: memorialTakeoverRequests.createdAt,
    })
    .from(memorialTakeoverRequests)
    .where(eq(memorialTakeoverRequests.id, requestId));
  if (!req) return err("REQUEST_NOT_FOUND");
  if (req.requester !== actor.userId) return err("NOT_REQUESTER");
  // Only a takeover escalates to arbitration; a join simply awaits the admin.
  if (req.kind !== "takeover") return err("NOT_PENDING");
  if (req.status !== "pending") return err("NOT_PENDING");
  if (Date.now() - req.createdAt.getTime() < GRACE_MS) return err("TOO_SOON");

  const dispute = await openOwnershipDispute(
    actor,
    {
      memorialId: req.memorialId,
      claimedRelationship: req.relationship as TakeoverRelationship,
      statement: req.reason,
    },
    correlationId,
  );
  if (!dispute.ok) return err("MEMORIAL_NOT_FOUND");

  await db()
    .update(memorialTakeoverRequests)
    .set({ status: "escalated" })
    .where(eq(memorialTakeoverRequests.id, requestId));

  const owner = await memorialOwner(req.memorialId);
  if (owner) {
    const memName = await memorialPrimaryName(req.memorialId);
    await notify({
      recipientUserId: owner,
      memorialId: req.memorialId,
      subject: memName,
      body: `「${memName}」追思页的接管申请已升级至平台仲裁。`,
      templateKey: "takeoverEscalated",
      templateParams: { name: memName },
    });
  }

  return ok({ disputeId: dispute.value.disputeId });
}

export type MyTakeover = {
  id: string;
  kind: "takeover" | "join";
  status: "pending" | "accepted" | "declined" | "escalated" | "withdrawn";
  createdAt: Date;
  canEscalate: boolean;
};

/** The current user's own takeover/join request on a memorial, if any. */
export async function myTakeoverRequest(
  memorialId: string,
  userId: string,
): Promise<MyTakeover | null> {
  const [row] = await db()
    .select({
      id: memorialTakeoverRequests.id,
      kind: memorialTakeoverRequests.kind,
      status: memorialTakeoverRequests.status,
      createdAt: memorialTakeoverRequests.createdAt,
    })
    .from(memorialTakeoverRequests)
    .where(
      and(
        eq(memorialTakeoverRequests.memorialId, memorialId),
        eq(memorialTakeoverRequests.requesterUserId, userId),
      ),
    );
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.createdAt,
    canEscalate:
      row.kind === "takeover" &&
      row.status === "pending" &&
      Date.now() - row.createdAt.getTime() >= GRACE_MS,
  };
}

export type PendingTakeover = {
  id: string;
  kind: "takeover" | "join";
  requesterName: string;
  relationship: string;
  reason: string;
  createdAt: Date;
};

/** Pending takeover/join requests on a memorial, for its owner to answer. */
export async function listPendingTakeovers(
  memorialId: string,
): Promise<PendingTakeover[]> {
  const rows = await db()
    .select({
      id: memorialTakeoverRequests.id,
      kind: memorialTakeoverRequests.kind,
      relationship: memorialTakeoverRequests.relationship,
      reason: memorialTakeoverRequests.reason,
      createdAt: memorialTakeoverRequests.createdAt,
      displayName: users.displayName,
      fullName: users.fullName,
    })
    .from(memorialTakeoverRequests)
    .leftJoin(users, eq(users.id, memorialTakeoverRequests.requesterUserId))
    .where(
      and(
        eq(memorialTakeoverRequests.memorialId, memorialId),
        eq(memorialTakeoverRequests.status, "pending"),
      ),
    )
    .orderBy(desc(memorialTakeoverRequests.createdAt));

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    requesterName: r.displayName ?? r.fullName ?? "",
    relationship: r.relationship,
    reason: r.reason,
    createdAt: r.createdAt,
  }));
}

export type PendingClaim = PendingTakeover & {
  memorialId: string;
  slug: string;
  memorialName: string;
};

/**
 * Every pending takeover/join request across all memorials, newest first.
 *
 * The platform's claims queue: seed pages are owned by a bot steward that never
 * signs in, so their claims would sit unanswered without a place for staff to
 * see and act on them. Caller checks the actor is staff.
 */
export async function listAllPendingClaims(): Promise<PendingClaim[]> {
  const rows = await db()
    .select({
      id: memorialTakeoverRequests.id,
      memorialId: memorialTakeoverRequests.memorialId,
      slug: memorials.slug,
      memorialName: memorialNames.value,
      kind: memorialTakeoverRequests.kind,
      relationship: memorialTakeoverRequests.relationship,
      reason: memorialTakeoverRequests.reason,
      createdAt: memorialTakeoverRequests.createdAt,
      displayName: users.displayName,
      fullName: users.fullName,
    })
    .from(memorialTakeoverRequests)
    .innerJoin(memorials, eq(memorials.id, memorialTakeoverRequests.memorialId))
    .leftJoin(
      memorialNames,
      and(
        eq(memorialNames.memorialId, memorials.id),
        eq(memorialNames.type, "primary"),
      ),
    )
    .leftJoin(users, eq(users.id, memorialTakeoverRequests.requesterUserId))
    .where(eq(memorialTakeoverRequests.status, "pending"))
    .orderBy(desc(memorialTakeoverRequests.createdAt));

  return rows.map((r) => ({
    id: r.id,
    memorialId: r.memorialId,
    slug: r.slug,
    memorialName: r.memorialName ?? "—",
    kind: r.kind,
    requesterName: r.displayName ?? r.fullName ?? "",
    relationship: r.relationship,
    reason: r.reason,
    createdAt: r.createdAt,
  }));
}
