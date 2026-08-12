import { and, eq, gt, or } from "drizzle-orm";

import {
  conversationMembers,
  conversations,
  profiles,
  realtimePairRevocations,
  sessions,
  userBlocks,
  users,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import { type SocketTicketKeyRing, verifySocketTicket } from "@/modules/messaging/socket-ticket";
import type { ModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";

import type { RealtimeAuthorization, SocketIdentity } from "./server";

type RealtimeDatabase = typeof productionDatabase;

const unauthorized = (): never => { throw new Error("NOT_AUTHORIZED"); };

export class DrizzleRealtimeAuthorization implements RealtimeAuthorization {
  private readonly database: RealtimeDatabase;
  private readonly clock: () => Date;

  constructor(database: unknown, private readonly keys: SocketTicketKeyRing, options: {
    clock?: () => Date;
    restrictionPolicy: ModerationRestrictionPolicy;
  }) {
    this.database = database as RealtimeDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.restrictionPolicy = options.restrictionPolicy;
  }
  private readonly restrictionPolicy: ModerationRestrictionPolicy;

  async authenticate(ticket: string): Promise<SocketIdentity> {
    let verified: ReturnType<typeof verifySocketTicket>;
    const now = this.clock();
    try {
      verified = verifySocketTicket(ticket, this.keys, now);
    } catch {
      return unauthorized();
    }
    const [row] = await this.database.select({ sessionId: sessions.id, expiresAt: sessions.expiresAt }).from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(and(
        eq(sessions.id, verified.sessionId),
        eq(sessions.userId, verified.sub),
        gt(sessions.expiresAt, now),
        eq(profiles.status, "active"),
    )).limit(1);
    if (!row) return unauthorized();
    const allowed = await this.restrictionPolicy.filterAllowedInTransaction(
      this.database, [verified.sub], "messaging", now,
    );
    if (!allowed.has(verified.sub)) return unauthorized();
    return {
      userId: verified.sub,
      sessionId: verified.sessionId,
      issuedAt: verified.issuedAt,
      expiresAt: new Date(Math.min(verified.exp * 1000, row.expiresAt.getTime())),
    };
  }

  async authorizeConversation(identity: SocketIdentity, conversationId: string) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as RealtimeDatabase;
      const now = this.clock();
      if (identity.expiresAt.getTime() <= now.getTime()) return unauthorized();
      const [activeSession] = await tx.select({ id: sessions.id }).from(sessions)
        .innerJoin(profiles, eq(profiles.userId, sessions.userId))
        .where(and(
          eq(sessions.id, identity.sessionId),
          eq(sessions.userId, identity.userId),
          gt(sessions.expiresAt, now),
          eq(profiles.status, "active"),
        )).limit(1);
      if (!activeSession) return unauthorized();
      const [conversation] = await tx.select({
        id: conversations.id,
        lowUserId: conversations.lowUserId,
        highUserId: conversations.highUserId,
      }).from(conversations).innerJoin(conversationMembers, and(
        eq(conversationMembers.conversationId, conversations.id),
        eq(conversationMembers.userId, identity.userId),
      )).where(and(
        eq(conversations.id, conversationId),
        eq(conversations.status, "active"),
        or(eq(conversations.lowUserId, identity.userId), eq(conversations.highUserId, identity.userId)),
      )).limit(1);
      if (!conversation) return unauthorized();
      const allowedUsers = await this.restrictionPolicy.filterAllowedInTransaction(
        tx, [conversation.lowUserId, conversation.highUserId], "messaging", now,
      );
      if (!allowedUsers.has(conversation.lowUserId) || !allowedUsers.has(conversation.highUserId)) {
        return unauthorized();
      }
      await tx.select({ id: users.id }).from(users).where(or(
        eq(users.id, conversation.lowUserId),
        eq(users.id, conversation.highUserId),
      )).orderBy(users.id).for("share");
      const [blocked] = await tx.select({ id: userBlocks.id }).from(userBlocks).where(or(
        and(eq(userBlocks.blockerUserId, conversation.lowUserId), eq(userBlocks.blockedUserId, conversation.highUserId)),
        and(eq(userBlocks.blockerUserId, conversation.highUserId), eq(userBlocks.blockedUserId, conversation.lowUserId)),
      )).limit(1);
      if (blocked) return unauthorized();
      const [revocation] = await tx.select({
        version: realtimePairRevocations.version,
        revokedBefore: realtimePairRevocations.revokedBefore,
      }).from(realtimePairRevocations).where(and(
        eq(realtimePairRevocations.lowUserId, conversation.lowUserId),
        eq(realtimePairRevocations.highUserId, conversation.highUserId),
      )).limit(1);
      if (revocation && identity.issuedAt.getTime() <= revocation.revokedBefore.getTime()) return unauthorized();
      return {
        conversationId: conversation.id,
        lowUserId: conversation.lowUserId,
        highUserId: conversation.highUserId,
        revocationVersion: revocation?.version ?? 0,
      };
    });
  }
}

export class DrizzleRealtimeRevocationSource {
  private readonly database: RealtimeDatabase;
  constructor(database: unknown) { this.database = database as RealtimeDatabase; }

  async versionsForPairs(pairs: Array<{ lowUserId: string; highUserId: string }>) {
    if (pairs.length > 100) throw new Error("REVOCATION_BATCH_TOO_LARGE");
    const results: Array<{ lowUserId: string; highUserId: string; version: number }> = [];
    for (const pair of pairs) {
      const [row] = await this.database.select({
        lowUserId: realtimePairRevocations.lowUserId,
        highUserId: realtimePairRevocations.highUserId,
        version: realtimePairRevocations.version,
      }).from(realtimePairRevocations).where(and(
        eq(realtimePairRevocations.lowUserId, pair.lowUserId),
        eq(realtimePairRevocations.highUserId, pair.highUserId),
      )).limit(1);
      if (row) results.push(row);
    }
    return results;
  }
}
