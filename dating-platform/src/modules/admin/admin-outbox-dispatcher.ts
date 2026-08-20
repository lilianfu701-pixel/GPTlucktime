import { randomUUID } from "node:crypto";

import { and, eq, gt, lte, or, sql } from "drizzle-orm";

import { adminOutboxEvents } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type AdminDatabase = typeof productionDatabase;

export type AdminOutboxMessage = {
  eventId: string;
  deduplicationKey: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  requestId: string;
  payload: Readonly<Record<string, unknown>>;
  createdAt: string;
};

export interface AdminEventSink { publish(message: AdminOutboxMessage): Promise<void> }
type Claim = AdminOutboxMessage & { leaseId: string };

export class DrizzleAdminOutboxRepository {
  constructor(private readonly database: AdminDatabase, private readonly sink: AdminEventSink) {}

  async claim(input: { limit: number; now: Date; leaseMs: number }): Promise<Claim[]> {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const rows = await tx.select().from(adminOutboxEvents).where(or(
        and(or(eq(adminOutboxEvents.status, "pending"), eq(adminOutboxEvents.status, "retrying")),
          lte(adminOutboxEvents.availableAt, input.now)),
        and(eq(adminOutboxEvents.status, "processing"),
          lte(adminOutboxEvents.leaseExpiresAt, sql`statement_timestamp()`)),
      )).orderBy(adminOutboxEvents.availableAt, adminOutboxEvents.id)
        .for("update", { skipLocked: true }).limit(input.limit);
      const claims: Claim[] = [];
      for (const row of rows) {
        if (row.status === "processing" && row.attempts >= 4) {
          await tx.update(adminOutboxEvents).set({ status: "failed", attempts: row.attempts + 1,
            leaseId: null, leaseExpiresAt: null, lastErrorCode: "ADMIN_OUTBOX_LEASE_RECOVERY_EXHAUSTED",
            manualReviewAt: input.now }).where(eq(adminOutboxEvents.id, row.id));
          continue;
        }
        const leaseId = randomUUID();
        const leaseBase = Math.max(input.now.getTime(), Date.now());
        const [claimed] = await tx.update(adminOutboxEvents).set({ status: "processing",
          attempts: row.attempts + 1, leaseId, leaseExpiresAt: new Date(leaseBase + input.leaseMs),
          lastErrorCode: null }).where(eq(adminOutboxEvents.id, row.id)).returning();
        if (!claimed) continue;
        claims.push({ eventId: row.id, deduplicationKey: row.id, eventType: row.eventType,
          aggregateType: row.aggregateType, aggregateId: row.aggregateId, requestId: row.requestId,
          payload: row.payload, createdAt: row.createdAt.toISOString(), leaseId });
      }
      return claims;
    });
  }

  async dispatch(claim: Claim, now: Date): Promise<"delivered" | "retry" | "manual_review"> {
    try {
      await this.sink.publish({ eventId: claim.eventId, deduplicationKey: claim.deduplicationKey,
        eventType: claim.eventType, aggregateType: claim.aggregateType, aggregateId: claim.aggregateId,
        requestId: claim.requestId, payload: claim.payload, createdAt: claim.createdAt });
    } catch {
      return this.release(claim, now);
    }
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const [delivered] = await tx.update(adminOutboxEvents).set({ status: "delivered", deliveredAt: now,
        leaseId: null, leaseExpiresAt: null, lastErrorCode: null }).where(and(
        eq(adminOutboxEvents.id, claim.eventId), eq(adminOutboxEvents.status, "processing"),
        eq(adminOutboxEvents.leaseId, claim.leaseId),
        gt(adminOutboxEvents.leaseExpiresAt, sql`statement_timestamp()`))).returning();
      return delivered ? "delivered" as const : "retry" as const;
    });
  }

  private async release(claim: Claim, now: Date) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as AdminDatabase;
      const [event] = await tx.select().from(adminOutboxEvents).where(and(
        eq(adminOutboxEvents.id, claim.eventId), eq(adminOutboxEvents.status, "processing"),
        eq(adminOutboxEvents.leaseId, claim.leaseId),
        gt(adminOutboxEvents.leaseExpiresAt, sql`statement_timestamp()`))).for("update").limit(1);
      if (!event) return "retry" as const;
      const manualReview = event.attempts >= 5;
      await tx.update(adminOutboxEvents).set({ status: manualReview ? "failed" : "retrying",
        availableAt: new Date(now.getTime() + Math.min(60 * 60_000, 2 ** event.attempts * 1_000)),
        leaseId: null, leaseExpiresAt: null, lastErrorCode: "ADMIN_OUTBOX_DELIVERY_RETRY",
        manualReviewAt: manualReview ? now : null }).where(eq(adminOutboxEvents.id, event.id));
      return manualReview ? "manual_review" as const : "retry" as const;
    });
  }
}

export class AdminOutboxWorker {
  private readonly now: () => Date;
  constructor(private readonly repository: DrizzleAdminOutboxRepository, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async run(rawLimit = 25) {
    const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
    const claims = await this.repository.claim({ limit, now: this.now(), leaseMs: 30_000 });
    const result = { claimed: claims.length, delivered: 0, retried: 0, manualReview: 0 };
    for (const claim of claims) {
      const outcome = await this.repository.dispatch(claim, this.now());
      if (outcome === "delivered") result.delivered += 1;
      else if (outcome === "retry") result.retried += 1;
      else result.manualReview += 1;
    }
    return result;
  }
}

type RedisEvalClient = { isOpen?: boolean; connect?(): Promise<unknown>;
  eval(script: string, input: { keys: string[]; arguments: string[] }): Promise<unknown> };

export class RedisStreamAdminEventSink implements AdminEventSink {
  constructor(private readonly redis: RedisEvalClient, private readonly streamKey = "admin:governance:events") {}

  async publish(message: AdminOutboxMessage) {
    if (this.redis.isOpen === false && this.redis.connect) await this.redis.connect();
    const script = `
      local existing = redis.call('GET', KEYS[1])
      if existing then return existing end
      local streamId = redis.call('XADD', KEYS[2], '*', 'eventId', ARGV[1], 'eventType', ARGV[2],
        'aggregateType', ARGV[3], 'aggregateId', ARGV[4], 'requestId', ARGV[5], 'payload', ARGV[6],
        'createdAt', ARGV[7])
      redis.call('SET', KEYS[1], streamId, 'NX', 'EX', 2592000)
      return streamId`;
    const acknowledgement = await this.redis.eval(script,
      { keys: [`admin:governance:dedup:${message.deduplicationKey}`, this.streamKey],
      arguments: [message.eventId, message.eventType, message.aggregateType, message.aggregateId,
        message.requestId, JSON.stringify(message.payload), message.createdAt] });
    if (typeof acknowledgement !== "string" || !/^\d+-\d+$/u.test(acknowledgement)) {
      throw new Error("ADMIN_EVENT_SINK_INVALID_ACK");
    }
  }
}
