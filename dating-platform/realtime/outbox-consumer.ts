import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { conversations, messageOutboxEvents, messages } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import type { InteractionPolicy } from "@/modules/social/social-repository";
import {
  allowAllContentPolicy,
  type ModerationContentPolicy,
} from "@/modules/moderation/content-policy";
import {
  allowAllRestrictionPolicy,
  type ModerationRestrictionPolicy,
} from "@/modules/moderation/restriction-policy";
import type { RealtimeMessageEvent } from "./server";

export type ClaimedMessageEvent = {
  id: string;
  leaseId: string;
  attempts: number;
  payload: {
    messageId: string;
    conversationId: string;
    senderUserId: string;
    sequence: number;
  };
};
export interface MessageOutboxStore {
  claim(limit: number): Promise<ClaimedMessageEvent[]>;
  markPublished(id: string, leaseId: string): Promise<boolean>;
  reschedule(id: string, leaseId: string, update: { failed: boolean; delayMs: number }): Promise<boolean>;
  suppress(id: string, leaseId: string): Promise<boolean>;
  failInvalid(id: string, leaseId: string): Promise<boolean>;
}

// Transport is deliberately at-least-once. Clients deduplicate by eventId,
// messageId and conversation sequence; PostgreSQL remains the recovery source.
export const REALTIME_DELIVERY_SEMANTICS = "at-least-once" as const;

const claimedEventSchema = z.object({
  id: z.string().uuid(),
  leaseId: z.string().uuid(),
  attempts: z.number().int().min(1).max(1_000_000),
  payload: z.object({
    messageId: z.string().uuid(),
    conversationId: z.string().uuid(),
    senderUserId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict();

export class MessageOutboxConsumer {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  constructor(
    private readonly store: MessageOutboxStore,
    private readonly publish: (event: RealtimeMessageEvent) => Promise<void>,
    options: { batchSize?: number; maxAttempts?: number; baseBackoffMs?: number } = {},
  ) {
    this.batchSize = Math.min(Math.max(options.batchSize ?? 20, 1), 100);
    this.maxAttempts = Math.min(Math.max(options.maxAttempts ?? 5, 1), 20);
    this.baseBackoffMs = Math.min(Math.max(options.baseBackoffMs ?? 1_000, 100), 60_000);
  }

  async runOnce() {
    const claimed = await this.store.claim(this.batchSize);
    for (const rawEvent of claimed) {
      const parsed = claimedEventSchema.safeParse(rawEvent);
      if (!parsed.success) {
        await this.store.failInvalid(rawEvent.id, rawEvent.leaseId);
        continue;
      }
      const event = parsed.data;
      try {
        await this.publish({
          eventId: event.id,
          messageId: event.payload.messageId,
          conversationId: event.payload.conversationId,
          sequence: event.payload.sequence,
        });
        await this.store.markPublished(event.id, event.leaseId);
      } catch (error) {
        if (error instanceof Error && error.message === "DELIVERY_NOT_ALLOWED") {
          await this.store.suppress(event.id, event.leaseId);
          continue;
        }
        const failed = event.attempts >= this.maxAttempts;
        const delayMs = failed ? 0 : Math.min(this.baseBackoffMs * 2 ** Math.max(event.attempts - 1, 0), 300_000);
        await this.store.reschedule(event.id, event.leaseId, { failed, delayMs });
      }
    }
    return claimed.length;
  }
}

export function createAuthorizedRealtimePublisher(
  database: unknown,
  interactionPolicy: Pick<InteractionPolicy, "withAllowedInteraction">,
  emit: (event: RealtimeMessageEvent) => Promise<void>,
  options: {
    restrictionPolicy?: ModerationRestrictionPolicy;
    contentPolicy?: ModerationContentPolicy;
    clock?: () => Date;
  } = {},
) {
  const db = database as OutboxDatabase;
  const restrictionPolicy = options.restrictionPolicy ?? allowAllRestrictionPolicy;
  const contentPolicy = options.contentPolicy ?? allowAllContentPolicy;
  return async (event: RealtimeMessageEvent) => {
    const [pair] = await db.select({
      lowUserId: conversations.lowUserId,
      highUserId: conversations.highUserId,
    }).from(conversations).where(eq(conversations.id, event.conversationId)).limit(1);
    if (!pair) throw new Error("DELIVERY_NOT_ALLOWED");
    try {
      await interactionPolicy.withAllowedInteraction(pair.lowUserId, pair.highUserId, async (transaction) => {
        const tx = transaction as OutboxDatabase;
        const now = options.clock?.() ?? new Date();
        const allowedUsers = await restrictionPolicy.filterAllowedInTransaction(
          transaction, [pair.lowUserId, pair.highUserId], "messaging", now,
        );
        if (!allowedUsers.has(pair.lowUserId) || !allowedUsers.has(pair.highUserId)) {
          throw new Error("DELIVERY_NOT_ALLOWED");
        }
        const visibleMessageIds = await contentPolicy.filterVisibleMessageIdsInTransaction(
          transaction, [event.messageId], now,
        );
        if (!visibleMessageIds.has(event.messageId)) throw new Error("DELIVERY_NOT_ALLOWED");
        const [authorized] = await tx.select({ id: messageOutboxEvents.id })
          .from(messageOutboxEvents)
          .innerJoin(messages, eq(messages.id, messageOutboxEvents.messageId))
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(and(
            eq(messageOutboxEvents.id, event.eventId),
            eq(messageOutboxEvents.messageId, event.messageId),
            eq(messageOutboxEvents.status, "processing"),
            eq(messages.conversationId, event.conversationId),
            eq(messages.sequence, event.sequence),
            eq(conversations.status, "active"),
          )).limit(1);
        if (!authorized) throw new Error("DELIVERY_NOT_ALLOWED");
        await emit(event);
      });
    } catch (error) {
      if (error instanceof Error && ["INTERACTION_NOT_ALLOWED", "DELIVERY_NOT_ALLOWED"].includes(error.message)) {
        throw new Error("DELIVERY_NOT_ALLOWED");
      }
      throw error;
    }
  };
}

type OutboxDatabase = typeof productionDatabase;
type QueryRow = Record<string, unknown>;
const rowsOf = (result: unknown): QueryRow[] => {
  if (Array.isArray(result)) return result as QueryRow[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray((result as { rows: unknown }).rows)) {
    return (result as { rows: QueryRow[] }).rows;
  }
  return [];
};

export class DrizzleMessageOutboxStore implements MessageOutboxStore {
  private readonly database: OutboxDatabase;
  constructor(database: unknown, private readonly options: { leaseMs?: number; clock?: () => Date } = {}) {
    this.database = database as OutboxDatabase;
  }

  async claim(limit: number) {
    const bounded = Math.min(Math.max(limit, 1), 100);
    const now = this.options.clock?.() ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + Math.min(Math.max(this.options.leaseMs ?? 30_000, 5_000), 300_000));
    const result = await this.database.execute(sql`
      WITH candidates AS (
        SELECT id
        FROM message_outbox_events
        WHERE (
          (status = 'pending' AND available_at <= ${now})
          OR (status = 'processing' AND lease_expires_at <= ${now})
        )
        ORDER BY available_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${bounded}
      )
      UPDATE message_outbox_events event
      SET status = 'processing', attempts = event.attempts + 1,
          lease_id = gen_random_uuid(), lease_expires_at = ${leaseExpiresAt}
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id, event.lease_id, event.attempts, event.payload
    `);
    return rowsOf(result).map((row) => ({
      id: String(row.id),
      leaseId: String(row.lease_id ?? row.leaseId),
      attempts: Number(row.attempts),
      payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as ClaimedMessageEvent["payload"],
    }));
  }

  async markPublished(id: string, leaseId: string) {
    const now = this.options.clock?.() ?? new Date();
    const result = await this.database.execute(sql`
      UPDATE message_outbox_events
      SET status = 'published', published_at = ${now}, lease_id = NULL, lease_expires_at = NULL,
          last_error_code = NULL, failed_at = NULL
      WHERE id = ${id}::uuid AND lease_id = ${leaseId}::uuid AND status = 'processing'
      RETURNING id
    `);
    return rowsOf(result).length === 1;
  }

  async reschedule(id: string, leaseId: string, update: { failed: boolean; delayMs: number }) {
    const now = this.options.clock?.() ?? new Date();
    const availableAt = new Date(now.getTime() + update.delayMs);
    const result = await this.database.execute(sql`
      UPDATE message_outbox_events
      SET status = ${update.failed ? "failed" : "pending"},
          available_at = ${availableAt}, lease_id = NULL, lease_expires_at = NULL,
          last_error_code = 'PUBLISH_FAILED', failed_at = ${update.failed ? now : null}
      WHERE id = ${id}::uuid AND lease_id = ${leaseId}::uuid AND status = 'processing'
      RETURNING id
    `);
    return rowsOf(result).length === 1;
  }

  async suppress(id: string, leaseId: string) {
    const now = this.options.clock?.() ?? new Date();
    const result = await this.database.execute(sql`
      UPDATE message_outbox_events
      SET status = 'suppressed', lease_id = NULL, lease_expires_at = NULL,
          last_error_code = NULL, failed_at = NULL,
          suppression_reason = 'PAIR_BLOCKED', suppressed_at = ${now}
      WHERE id = ${id}::uuid AND lease_id = ${leaseId}::uuid AND status = 'processing'
      RETURNING id
    `);
    return rowsOf(result).length === 1;
  }

  async failInvalid(id: string, leaseId: string) {
    const now = this.options.clock?.() ?? new Date();
    const result = await this.database.execute(sql`
      UPDATE message_outbox_events
      SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
          last_error_code = 'INVALID_PAYLOAD', failed_at = ${now},
          suppression_reason = NULL, suppressed_at = NULL
      WHERE id = ${id}::uuid AND lease_id = ${leaseId}::uuid AND status = 'processing'
      RETURNING id
    `);
    return rowsOf(result).length === 1;
  }
}
