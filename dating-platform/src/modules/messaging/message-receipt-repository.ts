import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { conversationMembers, conversations, messageReceipts, messages } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import type { SocialTransaction } from "@/modules/social/social-repository";
import type { ModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";

type ReceiptDatabase = typeof productionDatabase;
type ReceiptPolicy = {
  withAllowedInteraction<T>(actorUserId: string, targetUserId: string, write: (tx: SocialTransaction) => Promise<T>): Promise<T>;
};
const inputSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  kind: z.enum(["delivered", "read"]),
  at: z.string().datetime({ offset: true }),
}).strict();

const unavailable = (): never => { throw new Error("RECEIPT_NOT_AVAILABLE"); };
const maxDate = (...values: Array<Date | null | undefined>) => new Date(Math.max(...values.filter(Boolean).map((value) => value!.getTime())));

export class MessageReceiptRepository {
  private readonly database: ReceiptDatabase;
  private readonly clock: () => Date;
  constructor(database: unknown, private readonly options: {
    interactionPolicy: ReceiptPolicy;
    restrictionPolicy: ModerationRestrictionPolicy;
    clock?: () => Date;
  }) {
    this.database = database as ReceiptDatabase;
    this.clock = options.clock ?? (() => new Date());
  }

  async record(userId: string, raw: unknown) {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return unavailable();
    const now = this.clock();
    const at = now;
    const [message] = await this.database.select({
      senderUserId: messages.senderUserId,
      conversationId: messages.conversationId,
    }).from(messages).innerJoin(conversationMembers, and(
      eq(conversationMembers.conversationId, messages.conversationId),
      eq(conversationMembers.userId, userId),
    )).innerJoin(conversations, and(
      eq(conversations.id, messages.conversationId),
      eq(conversations.status, "active"),
    )).where(and(
      eq(messages.id, parsed.data.messageId),
      eq(messages.conversationId, parsed.data.conversationId),
    )).limit(1);
    if (!message || message.senderUserId === userId) return unavailable();
    try {
      return await this.options.interactionPolicy.withAllowedInteraction(userId, message.senderUserId, async (transaction) => {
        const tx = transaction as ReceiptDatabase;
        const allowed = await this.options.restrictionPolicy.filterAllowedInTransaction(
          transaction, [userId, message.senderUserId], "messaging", now,
        );
        if (!allowed.has(userId) || !allowed.has(message.senderUserId)) return unavailable();
        const [current] = await tx.select().from(messageReceipts).where(and(
          eq(messageReceipts.messageId, parsed.data.messageId),
          eq(messageReceipts.userId, userId),
        )).for("update").limit(1);
        let deliveredAt = current?.deliveredAt ?? null;
        let readAt = current?.readAt ?? null;
        if (parsed.data.kind === "delivered") deliveredAt = maxDate(deliveredAt, at);
        else {
          deliveredAt = maxDate(deliveredAt, at);
          readAt = maxDate(readAt, deliveredAt, at);
        }
        const values = {
          messageId: parsed.data.messageId,
          conversationId: parsed.data.conversationId,
          userId,
          deliveredAt,
          readAt,
          version: (current?.version ?? 0) + 1,
          updatedAt: now,
        };
        const [saved] = current
          ? await tx.update(messageReceipts).set(values).where(and(
            eq(messageReceipts.messageId, parsed.data.messageId),
            eq(messageReceipts.userId, userId),
          )).returning()
          : await tx.insert(messageReceipts).values(values).returning();
        return {
          messageId: saved.messageId,
          conversationId: saved.conversationId,
          userId: saved.userId,
          deliveredAt: saved.deliveredAt?.toISOString() ?? null,
          readAt: saved.readAt?.toISOString() ?? null,
        };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INTERACTION_NOT_ALLOWED") return unavailable();
      throw error;
    }
  }

  async listForSender(userId: string, conversationId: string, afterSequence: number, pageSize = 100) {
    if (!z.string().uuid().safeParse(conversationId).success
      || !Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return unavailable();
    const [membership] = await this.database.select({
      lowUserId: conversations.lowUserId,
      highUserId: conversations.highUserId,
    }).from(conversations).innerJoin(conversationMembers, and(
      eq(conversationMembers.conversationId, conversations.id),
      eq(conversationMembers.userId, userId),
    )).where(and(
      eq(conversations.id, conversationId),
      eq(conversations.status, "active"),
    )).limit(1);
    if (!membership || ![membership.lowUserId, membership.highUserId].includes(userId)) return unavailable();
    const targetUserId = membership.lowUserId === userId ? membership.highUserId : membership.lowUserId;
    try {
      return await this.options.interactionPolicy.withAllowedInteraction(userId, targetUserId, async (transaction) => {
        const tx = transaction as ReceiptDatabase;
        const allowed = await this.options.restrictionPolicy.filterAllowedInTransaction(
          transaction, [userId, targetUserId], "messaging", this.clock(),
        );
        if (!allowed.has(userId) || !allowed.has(targetUserId)) return unavailable();
        const rows = await tx.select({
          messageId: messages.id,
          sequence: messages.sequence,
          deliveredAt: messageReceipts.deliveredAt,
          readAt: messageReceipts.readAt,
        }).from(messages).innerJoin(messageReceipts, and(
          eq(messageReceipts.messageId, messages.id),
          eq(messageReceipts.conversationId, messages.conversationId),
        )).where(and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderUserId, userId),
          gt(messages.sequence, afterSequence),
        )).orderBy(asc(messages.sequence)).limit(pageSize + 1);
        const hasMore = rows.length > pageSize;
        const pageRows = rows.slice(0, pageSize);
        return { receipts: pageRows.map((row) => ({
          messageId: row.messageId,
          sequence: row.sequence,
          deliveredAt: row.deliveredAt?.toISOString() ?? null,
          readAt: row.readAt?.toISOString() ?? null,
        })), nextAfterSequence: hasMore ? pageRows.at(-1)?.sequence ?? null : null };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INTERACTION_NOT_ALLOWED") return unavailable();
      throw error;
    }
  }
}
