import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import {
  conversationMembers,
  conversations,
  messageOutboxEvents,
  messages,
  profiles,
  users,
  verificationAttempts,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import { launchVerificationPolicy, type VerificationDecision } from "@/modules/auth/verification-policy";
import type { EntitlementService } from "@/modules/entitlements/entitlement-service";
import {
  type ModerationRestrictionPolicy,
} from "@/modules/moderation/restriction-policy";
import {
  type ModerationContentPolicy,
} from "@/modules/moderation/content-policy";
import type { InteractionPolicy, SocialTransaction } from "@/modules/social/social-repository";
import { enqueueProductionNotification } from "@/modules/notifications/notification-producer";

import { normalizeSendMessageInput } from "./message-input";

type MessagingDatabase = typeof productionDatabase;
type MessageTransaction = SocialTransaction;
type Cursor = { timestamp: string; id: string };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONVERSATION_SCAN = 200;
const MAX_MESSAGE_VISIBILITY_SCAN = 500;
const MESSAGE_VISIBILITY_BATCH = 100;

export class MessagingError extends Error {
  constructor(
    readonly code: "CONVERSATION_NOT_AVAILABLE" | "MESSAGE_IDEMPOTENCY_CONFLICT"
      | "VERIFICATION_REQUIRED" | "MESSAGE_SEND_DENIED" | "INVALID_CURSOR" | "INVALID_MESSAGE",
    readonly unmet?: Array<keyof VerificationDecision>,
  ) {
    super(code);
  }
}

export interface MessageVerificationPolicy {
  unmetInTransaction(
    transaction: MessageTransaction,
    userId: string,
    now: Date,
  ): Promise<Array<keyof VerificationDecision>>;
}

export class DrizzleMessageVerificationPolicy implements MessageVerificationPolicy {
  async unmetInTransaction(transaction: MessageTransaction, userId: string, now: Date) {
    const tx = transaction as MessagingDatabase;
    const [account] = await tx.select({
      emailVerified: users.emailVerified,
      phoneVerified: users.phoneNumberVerified,
      countryCode: profiles.countryCode,
      profileStatus: profiles.status,
    }).from(users).leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId)).limit(1);
    if (!account) throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
    const approved = await tx.select({ kind: verificationAttempts.kind }).from(verificationAttempts).where(and(
      eq(verificationAttempts.userId, userId),
      eq(verificationAttempts.status, "approved"),
      gt(verificationAttempts.expiresAt, now),
    ));
    const approvedKinds = new Set(approved.map(({ kind }) => kind));
    const required = await launchVerificationPolicy.decide({
      selfDeclaredCountryCode: account.countryCode ?? "ZZ",
      risk: account.profileStatus && ["restricted", "suspended", "banned"].includes(account.profileStatus)
        ? "high"
        : "medium",
      action: "message",
    });
    const satisfied: VerificationDecision = {
      email: account.emailVerified,
      phone: account.phoneVerified,
      liveness: approvedKinds.has("liveness"),
      identity: approvedKinds.has("identity"),
    };
    return (Object.keys(required) as Array<keyof VerificationDecision>)
      .filter((key) => required[key] && !satisfied[key]);
  }
}

const orderedPair = (left: string, right: string) => left < right
  ? { lowUserId: left, highUserId: right }
  : { lowUserId: right, highUserId: left };

export const deriveMessageEntitlementOperationId = (senderUserId: string, clientId: string) => {
  const namespace = Buffer.from("20e13938671851b2b0a3cc840b02d62e", "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update("global-dating-platform.messaging.entitlement-operation.v1\0", "utf8")
    .update(senderUserId, "utf8")
    .update("\0message.send.daily\0", "utf8")
    .update(clientId, "utf8")
    .digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const serializeMessage = (row: typeof messages.$inferSelect, viewerUserId: string) => ({
  id: row.id,
  conversationId: row.conversationId,
  sequence: row.sequence,
  sender: row.senderUserId === viewerUserId ? "me" as const : "them" as const,
  body: row.body,
  createdAt: row.createdAt.toISOString(),
});

const cursorSignature = (body: string, secret: string) => createHmac("sha256", secret)
  .update(body).digest("base64url");
const encodeCursor = (cursor: Cursor, secret: string) => {
  const body = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  return `${body}.${cursorSignature(body, secret)}`;
};
const decodeCursor = (cursor: string | undefined, secret: string): Cursor | null => {
  if (!cursor) return null;
  const [body, signature, extra] = cursor.split(".");
  if (!body || !signature || extra || body.length > 1024 || signature.length > 100) {
    throw new MessagingError("INVALID_CURSOR");
  }
  const expected = cursorSignature(body, secret);
  const suppliedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new MessagingError("INVALID_CURSOR");
  }
  try {
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(decoded).length !== 2 || typeof decoded.timestamp !== "string"
      || Number.isNaN(Date.parse(decoded.timestamp)) || typeof decoded.id !== "string"
      || !UUID_PATTERN.test(decoded.id)) throw new Error();
    return { timestamp: decoded.timestamp, id: decoded.id };
  } catch {
    throw new MessagingError("INVALID_CURSOR");
  }
};

export class MessageRepository {
  private readonly database: MessagingDatabase;
  private readonly interactionPolicy: InteractionPolicy;
  private readonly entitlementService: Pick<EntitlementService, "consumeInTransaction" | "decideInTransaction">;
  private readonly verificationPolicy: MessageVerificationPolicy;
  private readonly restrictionPolicy: ModerationRestrictionPolicy;
  private readonly contentPolicy: ModerationContentPolicy;
  private readonly cursorSecret: string;
  private readonly clock: () => Date;

  constructor(database: unknown, options: {
    interactionPolicy: InteractionPolicy;
    entitlementService: Pick<EntitlementService, "consumeInTransaction" | "decideInTransaction">;
    verificationPolicy: MessageVerificationPolicy;
    restrictionPolicy: ModerationRestrictionPolicy;
    contentPolicy: ModerationContentPolicy;
    cursorSecret: string;
    clock?: () => Date;
  }) {
    this.database = database as MessagingDatabase;
    this.interactionPolicy = options.interactionPolicy;
    this.entitlementService = options.entitlementService;
    this.verificationPolicy = options.verificationPolicy;
    this.restrictionPolicy = options.restrictionPolicy;
    this.contentPolicy = options.contentPolicy;
    this.cursorSecret = options.cursorSecret;
    this.clock = options.clock ?? (() => new Date());
  }

  async createConversation(actorUserId: string, targetProfileId: string) {
    try {
      return await this.interactionPolicy.withAllowedProfileInteraction(
        actorUserId,
        targetProfileId,
        async (transaction, targetUserId) => {
          const tx = transaction as MessagingDatabase;
          const pair = orderedPair(actorUserId, targetUserId);
          const now = this.clock();
          const allowedUsers = await this.restrictionPolicy.filterAllowedInTransaction(
            transaction, [actorUserId, targetUserId], "messaging", now,
          );
          if (!allowedUsers.has(actorUserId) || !allowedUsers.has(targetUserId)) {
            throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
          }
          let [conversation] = await tx.select().from(conversations).where(and(
            eq(conversations.lowUserId, pair.lowUserId),
            eq(conversations.highUserId, pair.highUserId),
          )).limit(1);
          if (conversation) {
            if (conversation.status !== "active") throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
            return this.serializeConversation(conversation);
          }
          const unmet = await this.verificationPolicy.unmetInTransaction(transaction, actorUserId, now);
          if (unmet.length > 0) throw new MessagingError("VERIFICATION_REQUIRED", unmet);
          const entitlement = await this.entitlementService.decideInTransaction(
            transaction,
            actorUserId,
            "message.send.daily",
          );
          if (!entitlement.allowed) throw new MessagingError("MESSAGE_SEND_DENIED");
          [conversation] = await tx.insert(conversations).values({ ...pair, createdAt: now, updatedAt: now })
            .returning();
          await tx.insert(conversationMembers).values([
            { conversationId: conversation.id, userId: pair.lowUserId, ...pair, joinedAt: now, updatedAt: now },
            { conversationId: conversation.id, userId: pair.highUserId, ...pair, joinedAt: now, updatedAt: now },
          ]);
          return this.serializeConversation(conversation);
        },
      );
    } catch (error) {
      if (error instanceof MessagingError) throw error;
      if (error instanceof Error && error.message === "INTERACTION_NOT_ALLOWED") {
        throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
      }
      throw error;
    }
  }

  async sendMessage(
    senderUserId: string,
    conversationId: string,
    input: { clientId: string; body: string },
  ) {
    let normalized: { clientId: string; body: string };
    try {
      normalized = normalizeSendMessageInput(input);
    } catch {
      throw new MessagingError("INVALID_MESSAGE");
    }
    const membership = await this.findMembership(this.database, senderUserId, conversationId);
    if (!membership) throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
    const replay = await this.findReplay(this.database, senderUserId, normalized.clientId);
    if (replay) return this.validateReplay(replay, conversationId, normalized.body);
    const targetUserId = membership.lowUserId === senderUserId
      ? membership.highUserId
      : membership.lowUserId;
    try {
      return await this.interactionPolicy.withAllowedInteraction(senderUserId, targetUserId, async (transaction) => {
        const tx = transaction as MessagingDatabase;
        const lockedReplay = await this.findReplay(tx, senderUserId, normalized.clientId);
        if (lockedReplay) return this.validateReplay(lockedReplay, conversationId, normalized.body);
        const currentMembership = await this.findMembership(tx, senderUserId, conversationId);
        if (!currentMembership || currentMembership.status !== "active") {
          throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
        }
        const now = this.clock();
        const allowedUsers = await this.restrictionPolicy.filterAllowedInTransaction(
          transaction,
          [senderUserId, targetUserId],
          "messaging",
          now,
        );
        if (!allowedUsers.has(senderUserId) || !allowedUsers.has(targetUserId)) {
          throw new MessagingError("MESSAGE_SEND_DENIED");
        }
        const unmet = await this.verificationPolicy.unmetInTransaction(transaction, senderUserId, now);
        if (unmet.length > 0) throw new MessagingError("VERIFICATION_REQUIRED", unmet);
        const decision = await this.entitlementService.consumeInTransaction(transaction, {
          userId: senderUserId,
          key: "message.send.daily",
          operationId: deriveMessageEntitlementOperationId(senderUserId, normalized.clientId),
          amount: 1,
          context: { conversationId },
        });
        if (!decision.allowed) throw new MessagingError("MESSAGE_SEND_DENIED");

        const [lockedConversation] = await tx.select().from(conversations).where(and(
          eq(conversations.id, conversationId),
          eq(conversations.status, "active"),
        )).for("update").limit(1);
        if (!lockedConversation) throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
        const sequence = lockedConversation.nextSequence;
        if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
          throw new Error("CONVERSATION_SEQUENCE_EXHAUSTED");
        }
        const [message] = await tx.insert(messages).values({
          conversationId,
          lowUserId: currentMembership.lowUserId,
          highUserId: currentMembership.highUserId,
          sequence,
          senderUserId,
          clientId: normalized.clientId,
          body: normalized.body,
          createdAt: now,
        }).returning();
        await tx.update(conversations).set({
          nextSequence: sequence + 1,
          version: sql`${conversations.version} + 1`,
          lastMessageAt: now,
          updatedAt: now,
        }).where(eq(conversations.id, conversationId));
        await tx.insert(messageOutboxEvents).values({
          messageId: message.id,
          eventType: "message.created",
          dedupeKey: `message.created:${message.id}`,
          payload: { messageId: message.id, conversationId, senderUserId, sequence },
          status: "pending",
          availableAt: now,
          createdAt: now,
        });
        await enqueueProductionNotification(tx, { userId: targetUserId,
          dedupeKey: `message-created:${message.id}:${targetUserId}`, category: "transactional",
          templateKey: "notifications.newMessage", payload: { conversationId, messageId: message.id,
            expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString() }, availableAt: now });
        return serializeMessage(message, senderUserId);
      });
    } catch (error) {
      if (error instanceof MessagingError) throw error;
      if (error instanceof Error && error.message === "INTERACTION_NOT_ALLOWED") {
        throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
      }
      throw error;
    }
  }

  async listMessages(
    userId: string,
    conversationId: string,
    input: { afterSequence: number; pageSize: number },
  ) {
    const membership = await this.findMembership(this.database, userId, conversationId);
    if (!membership) throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
    const counterpartUserId = membership.lowUserId === userId ? membership.highUserId : membership.lowUserId;
    const allowedUsers = await this.restrictionPolicy.filterAllowedInTransaction(
      this.database, [userId, counterpartUserId], "messaging", this.clock(),
    );
    if (!allowedUsers.has(userId) || !allowedUsers.has(counterpartUserId)) {
      throw new MessagingError("CONVERSATION_NOT_AVAILABLE");
    }
    const visibleRows: Array<typeof messages.$inferSelect> = [];
    let scanSequence = input.afterSequence;
    let scanned = 0;
    let reachedEnd = false;
    while (visibleRows.length <= input.pageSize && scanned < MAX_MESSAGE_VISIBILITY_SCAN && !reachedEnd) {
      const batchSize = Math.min(MESSAGE_VISIBILITY_BATCH, MAX_MESSAGE_VISIBILITY_SCAN - scanned);
      const rows = await this.database.select().from(messages).where(and(
        eq(messages.conversationId, conversationId),
        gt(messages.sequence, scanSequence),
      )).orderBy(asc(messages.sequence)).limit(batchSize);
      if (rows.length === 0) {
        reachedEnd = true;
        break;
      }
      scanned += rows.length;
      scanSequence = rows.at(-1)!.sequence;
      reachedEnd = rows.length < batchSize;
      const visibleIds = await this.contentPolicy.filterVisibleMessageIdsInTransaction(
        this.database,
        rows.map(({ id }) => id),
        this.clock(),
      );
      for (const row of rows) {
        if (visibleIds.has(row.id)) visibleRows.push(row);
        if (visibleRows.length > input.pageSize) break;
      }
    }
    const hasMore = visibleRows.length > input.pageSize || !reachedEnd;
    const pageRows = visibleRows.slice(0, input.pageSize);
    return {
      messages: pageRows.map((message) => serializeMessage(message, userId)),
      nextAfterSequence: hasMore ? pageRows.at(-1)?.sequence ?? scanSequence : null,
    };
  }

  async listConversations(userId: string, input: { pageSize: number; cursor?: string }) {
    const initialCursor = decodeCursor(input.cursor, this.cursorSecret);
    return this.interactionPolicy.withSafeViewerRead(userId, async (transaction) => {
      const tx = transaction as MessagingDatabase;
      const viewerAllowed = await this.restrictionPolicy.filterAllowedInTransaction(
        transaction, [userId], "messaging", this.clock(),
      );
      if (!viewerAllowed.has(userId)) return { conversations: [], nextCursor: null };
      const items: Array<Record<string, unknown>> = [];
      let after = initialCursor;
      let scanned = 0;
      let hasMore = false;
      while (items.length < input.pageSize && scanned < MAX_CONVERSATION_SCAN) {
        const limit = Math.min(50, MAX_CONVERSATION_SCAN - scanned);
        const sortTime = sql<Date>`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
        const rows = await tx.select({
          conversation: conversations,
          sortTime,
        }).from(conversations).innerJoin(conversationMembers, and(
          eq(conversationMembers.conversationId, conversations.id),
          eq(conversationMembers.userId, userId),
        )).where(and(
          eq(conversations.status, "active"),
          isNull(conversationMembers.hiddenAt),
          or(eq(conversations.lowUserId, userId), eq(conversations.highUserId, userId)),
          after ? or(
            lt(sortTime, new Date(after.timestamp)),
            and(eq(sortTime, new Date(after.timestamp)), gt(conversations.id, after.id)),
          ) : undefined,
        )).orderBy(desc(sortTime), asc(conversations.id)).limit(limit);
        if (rows.length === 0) break;
        const counterpartIds = rows.map(({ conversation }) => conversation.lowUserId === userId
          ? conversation.highUserId
          : conversation.lowUserId);
        const profilesByUser = await this.interactionPolicy.safeConversationProfilesInTransaction(
          transaction,
          userId,
          counterpartIds,
        );
        const allowedCounterparts = await this.restrictionPolicy.filterAllowedInTransaction(
          transaction, counterpartIds, "messaging", this.clock(),
        );
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index]!;
          scanned += 1;
          const rowSortTime = row.sortTime instanceof Date
            ? row.sortTime
            : new Date(String(row.sortTime));
          if (Number.isNaN(rowSortTime.getTime())) throw new Error("INVALID_CONVERSATION_TIMESTAMP");
          after = { timestamp: rowSortTime.toISOString(), id: row.conversation.id };
          const counterpartUserId = row.conversation.lowUserId === userId
            ? row.conversation.highUserId
            : row.conversation.lowUserId;
          const profile = profilesByUser.get(counterpartUserId);
          if (profile && allowedCounterparts.has(counterpartUserId)) {
            items.push({ ...this.serializeConversation(row.conversation), profile });
          }
          if (items.length === input.pageSize) {
            hasMore = index < rows.length - 1 || rows.length === limit;
            break;
          }
        }
        if (items.length === input.pageSize || rows.length < limit) break;
        hasMore = true;
      }
      return {
        conversations: items,
        nextCursor: hasMore && after ? encodeCursor(after, this.cursorSecret) : null,
      };
    });
  }

  private async findReplay(database: MessagingDatabase, senderUserId: string, clientId: string) {
    const [row] = await database.select().from(messages).where(and(
      eq(messages.senderUserId, senderUserId),
      eq(messages.clientId, clientId),
    )).limit(1);
    return row;
  }

  private validateReplay(row: typeof messages.$inferSelect, conversationId: string, body: string) {
    if (row.conversationId !== conversationId || row.body !== body) {
      throw new MessagingError("MESSAGE_IDEMPOTENCY_CONFLICT");
    }
    return serializeMessage(row, row.senderUserId);
  }

  private async findMembership(database: MessagingDatabase, userId: string, conversationId: string) {
    const [row] = await database.select({
      id: conversations.id,
      lowUserId: conversations.lowUserId,
      highUserId: conversations.highUserId,
      status: conversations.status,
    }).from(conversations).innerJoin(conversationMembers, and(
      eq(conversationMembers.conversationId, conversations.id),
      eq(conversationMembers.userId, userId),
    )).where(and(
      eq(conversations.id, conversationId),
      or(eq(conversations.lowUserId, userId), eq(conversations.highUserId, userId)),
    )).limit(1);
    return row;
  }

  private serializeConversation(row: typeof conversations.$inferSelect) {
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      latestSequence: row.nextSequence - 1,
    };
  }
}
