import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  emailCredentials,
  memorialInvitations,
  memorialMembers,
  memorials,
  outboxEvents,
} from "@/db/schema";
import { deriveKey, hmacHex, randomTokenHex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { normalizeEmail } from "@/modules/auth/normalize";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor, MemorialRole } from "@/modules/permissions/types";
import { memorialRoleFor } from "./membership";

/** Ownership moves by explicit transfer, never by sending someone a link. */
export type InvitableRole = Exclude<MemorialRole, "owner">;

export const INVITABLE_ROLES: readonly InvitableRole[] = [
  "admin",
  "editor",
  "reviewer",
  "invited_visitor",
];

export type InviteError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "INVALID_EMAIL"
  | "ROLE_NOT_INVITABLE"
  | "ALREADY_A_MEMBER";

export type AcceptError =
  | "AUTH_REQUIRED"
  | "INVITATION_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_USED"
  | "INVITATION_REVOKED";

const DEFAULT_EXPIRY_DAYS = 14;

export function hashInvitationToken(token: string, secret: string): string {
  return hmacHex(deriveKey(secret, "invitation-token"), token);
}

/**
 * Invites someone to help manage a memorial.
 *
 * Returns the token once, for the invitation email. Only its hash is kept, so
 * the table cannot be used to walk into a private memorial.
 */
export async function inviteMember(
  actor: Actor,
  memorialId: string,
  input: { email: string; role: InvitableRole; expiresInDays?: number | undefined },
  correlationId: string,
): Promise<
  Result<{ invitationId: string; token: string; expiresAt: Date }, InviteError>
> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  // Someone with no role must not learn the memorial exists.
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "manage_members" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  if (!INVITABLE_ROLES.includes(input.role)) {
    return err("ROLE_NOT_INVITABLE");
  }

  const normalized = normalizeEmail(input.email);
  if (!normalized.ok) {
    return err("INVALID_EMAIL");
  }

  const alreadyMember = await isAlreadyMember(memorialId, normalized.value);
  if (alreadyMember) {
    return err("ALREADY_A_MEMBER");
  }

  const token = randomTokenHex(32);
  const expiresAt = new Date(
    Date.now() + (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
  );

  const invitationId = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(memorialInvitations)
      .values({
        memorialId,
        email: normalized.value,
        role: input.role,
        tokenHash: hashInvitationToken(token, env().SESSION_SECRET),
        invitedByUserId: actor.userId ?? "",
        expiresAt,
      })
      .returning({ id: memorialInvitations.id });

    if (!row) {
      throw new Error("invitation insert returned no row");
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.member_invited",
      resourceType: "memorial",
      resourceId: memorialId,
      // The role is recorded; the address is not, so an audit trail does not
      // become a list of a family's contacts.
      newValue: { role: input.role, invitationId: row.id },
      correlationId,
    });

    await tx.insert(outboxEvents).values({
      topic: "notification.send",
      aggregateId: memorialId,
      payload: {
        kind: "memorial.invitation",
        invitationId: row.id,
        memorialId,
        correlationId,
      },
    });

    return row.id;
  });

  return ok({ invitationId, token, expiresAt });
}

/**
 * Accepts an invitation.
 *
 * The signed-in account becomes the member, whichever address the invitation
 * was sent to. Requiring the addresses to match would strand anyone who signed
 * in with Google under a different address, and the token is what proves they
 * received the invitation.
 */
export async function acceptInvitation(
  actor: Actor,
  token: string,
  correlationId: string,
): Promise<Result<{ memorialId: string; role: MemorialRole }, AcceptError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const tokenHash = hashInvitationToken(token, env().SESSION_SECRET);

  return db().transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(memorialInvitations)
      .where(eq(memorialInvitations.tokenHash, tokenHash))
      .for("update");

    if (!invitation) {
      return err("INVITATION_NOT_FOUND");
    }

    if (invitation.revokedAt) {
      return err("INVITATION_REVOKED");
    }

    if (invitation.acceptedAt) {
      return err("INVITATION_ALREADY_USED");
    }

    if (invitation.expiresAt.getTime() <= Date.now()) {
      return err("INVITATION_EXPIRED");
    }

    await tx
      .update(memorialInvitations)
      .set({
        acceptedAt: new Date(),
        acceptedByUserId: actor.userId,
      })
      .where(eq(memorialInvitations.id, invitation.id));

    await tx
      .insert(memorialMembers)
      .values({
        memorialId: invitation.memorialId,
        userId: actor.userId ?? "",
        role: invitation.role,
        invitedBy: invitation.invitedByUserId,
        acceptedAt: new Date(),
      })
      // Accepting a second invitation updates the role rather than failing.
      .onConflictDoUpdate({
        target: [memorialMembers.memorialId, memorialMembers.userId],
        set: { role: invitation.role, acceptedAt: new Date(), revokedAt: null },
      });

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.invitation_accepted",
      resourceType: "memorial",
      resourceId: invitation.memorialId,
      newValue: { role: invitation.role, invitationId: invitation.id },
      correlationId,
    });

    return ok({ memorialId: invitation.memorialId, role: invitation.role });
  });
}

/** Withdraws an invitation that has not been used. */
export async function revokeInvitation(
  actor: Actor,
  invitationId: string,
  correlationId: string,
): Promise<Result<{ revoked: boolean }, InviteError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [invitation] = await db()
    .select({
      id: memorialInvitations.id,
      memorialId: memorialInvitations.memorialId,
      acceptedAt: memorialInvitations.acceptedAt,
    })
    .from(memorialInvitations)
    .where(eq(memorialInvitations.id, invitationId));

  if (!invitation) {
    return err("MEMORIAL_NOT_FOUND");
  }

  const role = await memorialRoleFor(invitation.memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "manage_members" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  if (invitation.acceptedAt) {
    return ok({ revoked: false });
  }

  await db().transaction(async (tx) => {
    await tx
      .update(memorialInvitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(memorialInvitations.id, invitationId),
          isNull(memorialInvitations.revokedAt),
        ),
      );

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.invitation_revoked",
      resourceType: "memorial",
      resourceId: invitation.memorialId,
      newValue: { invitationId },
      correlationId,
    });
  });

  return ok({ revoked: true });
}

/**
 * Removes a member's access.
 *
 * The row is kept with `revokedAt` set rather than deleted, so a later dispute
 * can show who had access and when.
 */
export async function revokeMembership(
  actor: Actor,
  memorialId: string,
  targetUserId: string,
  correlationId: string,
): Promise<Result<{ revoked: boolean }, InviteError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "manage_members" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const [memorial] = await db()
    .select({ ownerUserId: memorials.ownerUserId })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  // The owner's own membership is not revocable here: a memorial with no owner
  // would be unmanageable. Ownership changes through transfer.
  if (memorial?.ownerUserId === targetUserId) {
    return err("MEMORIAL_FORBIDDEN");
  }

  await db().transaction(async (tx) => {
    await tx
      .update(memorialMembers)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(memorialMembers.memorialId, memorialId),
          eq(memorialMembers.userId, targetUserId),
          isNull(memorialMembers.revokedAt),
        ),
      );

    await tx.insert(auditLogs).values({
      actorUserId: actor.userId,
      action: "memorial.membership_revoked",
      resourceType: "memorial",
      resourceId: memorialId,
      newValue: { targetUserId },
      correlationId,
    });
  });

  return ok({ revoked: true });
}

async function isAlreadyMember(
  memorialId: string,
  email: string,
): Promise<boolean> {
  const [row] = await db()
    .select({ userId: memorialMembers.userId })
    .from(emailCredentials)
    .innerJoin(
      memorialMembers,
      eq(memorialMembers.userId, emailCredentials.userId),
    )
    .where(
      and(
        eq(emailCredentials.email, email),
        eq(memorialMembers.memorialId, memorialId),
        isNull(memorialMembers.revokedAt),
      ),
    );

  return row !== undefined;
}
