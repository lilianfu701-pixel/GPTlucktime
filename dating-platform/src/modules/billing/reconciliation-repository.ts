import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, gt, lt, lte, or, sql } from "drizzle-orm";

import {
  billingDisputes, billingPayments, billingReconciliationCursors, billingReconciliationItems, billingReconciliationRuns,
  billingReconciliationCollected, billingRefunds, billingSubscriptions,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import type { LedgerComparisonRow, LedgerSnapshot, ReconciliationDiscrepancy } from "./reconciliation-service";

type BillingDatabase = typeof productionDatabase;
const hash = (value: string | null) => value === null ? null : createHash("sha256").update(value).digest("hex");

export class DrizzleReconciliationStore {
  private readonly database: BillingDatabase;
  private readonly clock: () => Date;
  private readonly leaseMs: number;

  constructor(database: unknown, options: { clock?: () => Date; leaseMs?: number } = {}) {
    this.database = database as BillingDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 60_000;
  }

  async acquireRun(key: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(key)) throw new Error("RECONCILIATION_KEY_INVALID");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as BillingDatabase;
      const now = this.clock();
      const [existing] = await tx.select().from(billingReconciliationRuns)
        .where(eq(billingReconciliationRuns.runKey, key)).for("update").limit(1);
      if (existing?.status === "completed") {
        const [{ count }] = await tx.select({ count: sql<number>`count(*)` }).from(billingReconciliationItems)
          .where(eq(billingReconciliationItems.runId, existing.id));
        return { id: existing.id, cursor: null, phase: existing.phase as "provider" | "internal" | "compare",
          completed: true, discrepancyCount: Number(count), providerPages: existing.providerPages,
          internalPages: existing.internalPages, comparePages: existing.comparePages };
      }
      if (existing && existing.status === "running" && existing.leaseExpiresAt > now) return null;
      if (existing?.nextAttemptAt && existing.nextAttemptAt > now) return null;
      const leaseId = randomUUID();
      if (!existing) {
        const [created] = await tx.insert(billingReconciliationRuns).values({ runKey: key, leaseId,
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs), attempts: 0, startedAt: now, updatedAt: now }).returning();
        return { id: created!.id, cursor: null, phase: "provider" as const, leaseId,
          providerPages: 0, internalPages: 0, comparePages: 0 };
      }
      const [claimed] = await tx.update(billingReconciliationRuns).set({ status: "running", leaseId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs), nextAttemptAt: null, errorCode: null, updatedAt: now })
        .where(and(eq(billingReconciliationRuns.id, existing.id), lt(billingReconciliationRuns.attempts, 20)))
        .returning();
      return claimed ? { id: claimed.id, cursor: claimed.cursor,
        phase: claimed.phase as "provider" | "internal" | "compare", leaseId,
        providerPages: claimed.providerPages, internalPages: claimed.internalPages, comparePages: claimed.comparePages } : null;
    });
  }

  async snapshotPage(input: { cursor: string | null; limit: number }): Promise<LedgerSnapshot & { nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    let cursor: { s?: string; i?: string; r?: string; d?: string } = {};
    if (input.cursor) {
      if (input.cursor.length > 1_000 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) throw new Error("RECONCILIATION_CURSOR_INVALID");
      try {
        const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (Object.keys(parsed).some((key) => !["s", "i", "r", "d"].includes(key))
          || Object.values(parsed).some((value) => typeof value !== "string" || value.length > 255)) throw new Error();
        cursor = parsed as typeof cursor;
      } catch { throw new Error("RECONCILIATION_CURSOR_INVALID"); }
    }
    const done: LedgerSnapshot["subscriptions"] = [];
    const [subscriptions, invoices, refunds, disputes] = await Promise.all([
      cursor.s === "-" ? done : this.database.select({ id: billingSubscriptions.providerSubscriptionId,
        status: billingSubscriptions.providerStatus })
        .from(billingSubscriptions).where(cursor.s ? gt(billingSubscriptions.providerSubscriptionId, cursor.s) : undefined)
        .orderBy(asc(billingSubscriptions.providerSubscriptionId)).limit(limit),
      cursor.i === "-" ? done : this.database.select({ id: billingPayments.providerInvoiceId,
        status: sql<string>`'paid'`, amount: billingPayments.amount })
        .from(billingPayments).where(cursor.i ? gt(billingPayments.providerInvoiceId, cursor.i) : undefined)
        .orderBy(asc(billingPayments.providerInvoiceId)).limit(limit),
      cursor.r === "-" ? done : this.database.select({ id: billingRefunds.providerRefundId, amount: billingRefunds.amount })
        .from(billingRefunds).where(cursor.r ? gt(billingRefunds.providerRefundId, cursor.r) : undefined)
        .orderBy(asc(billingRefunds.providerRefundId)).limit(limit),
      cursor.d === "-" ? done : this.database.select({ id: billingDisputes.providerDisputeId, status: billingDisputes.status, amount: billingDisputes.amount })
        .from(billingDisputes).where(cursor.d ? gt(billingDisputes.providerDisputeId, cursor.d) : undefined)
        .orderBy(asc(billingDisputes.providerDisputeId)).limit(limit),
    ]);
    const position = (rows: LedgerSnapshot["subscriptions"], previous?: string) =>
      previous === "-" || rows.length < limit ? "-" : rows.at(-1)!.id;
    const next = { s: position(subscriptions, cursor.s), i: position(invoices, cursor.i),
      r: position(refunds, cursor.r), d: position(disputes, cursor.d) };
    const complete = Object.values(next).every((value) => value === "-");
    return { subscriptions, invoices, refunds, disputes,
      nextCursor: complete ? null : Buffer.from(JSON.stringify(next), "utf8").toString("base64url") };
  }

  async renewRun(runId: string, leaseId: string) {
    const now = this.clock();
    const rows = await this.database.update(billingReconciliationRuns)
      .set({ leaseExpiresAt: new Date(now.getTime() + this.leaseMs), updatedAt: now })
      .where(and(eq(billingReconciliationRuns.id, runId), eq(billingReconciliationRuns.status, "running"),
        eq(billingReconciliationRuns.leaseId, leaseId))).returning({ id: billingReconciliationRuns.id });
    if (rows.length !== 1) throw new Error("RECONCILIATION_LEASE_LOST");
  }

  async saveCollectedPage(runId: string, side: "provider" | "internal", page: LedgerSnapshot) {
    const values = (["subscriptions", "invoices", "refunds", "disputes"] as const).flatMap((objectType) =>
      page[objectType].map((row) => ({ runId, side, objectType, providerObjectId: row.id,
        objectStatus: row.status, amount: row.amount })));
    if (!values.length) return;
    await this.database.insert(billingReconciliationCollected).values(values).onConflictDoNothing();
  }

  async checkpointRun(runId: string, state: { phase: "provider" | "internal" | "compare"; cursor: string | null;
    providerPages: number; internalPages: number; comparePages: number },
    leaseId: string) {
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as BillingDatabase;
      const now = this.clock();
      if (state.cursor) {
        const recorded = await tx.insert(billingReconciliationCursors).values({ runId, phase: state.phase,
          cursorHash: hash(state.cursor)!, createdAt: now }).onConflictDoNothing().returning({ id: billingReconciliationCursors.id });
        if (recorded.length !== 1) throw new Error("RECONCILIATION_CURSOR_CYCLE");
      }
      const rows = await tx.update(billingReconciliationRuns).set({ status: "retry", phase: state.phase,
        cursor: state.cursor, providerPages: state.providerPages, internalPages: state.internalPages,
        comparePages: state.comparePages, leaseId: null, leaseExpiresAt: now, nextAttemptAt: now, updatedAt: now })
        .where(and(eq(billingReconciliationRuns.id, runId), eq(billingReconciliationRuns.status, "running"),
          eq(billingReconciliationRuns.leaseId, leaseId))).returning({ id: billingReconciliationRuns.id });
      if (rows.length !== 1) throw new Error("RECONCILIATION_LEASE_LOST");
    });
  }

  async comparisonPage(runId: string, input: { cursor: string | null; limit: number }) {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    let cursor: { objectType: keyof LedgerSnapshot; providerObjectId: string } | null = null;
    if (input.cursor) {
      if (input.cursor.length > 1_000 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) {
        throw new Error("RECONCILIATION_CURSOR_INVALID");
      }
      try {
        const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (!(parsed.t === "subscriptions" || parsed.t === "invoices" || parsed.t === "refunds" || parsed.t === "disputes")
          || typeof parsed.i !== "string" || parsed.i.length < 1 || parsed.i.length > 255) throw new Error();
        cursor = { objectType: parsed.t, providerObjectId: parsed.i };
      } catch { throw new Error("RECONCILIATION_CURSOR_INVALID"); }
    }
    const after = cursor ? or(gt(billingReconciliationCollected.objectType, cursor.objectType),
      and(eq(billingReconciliationCollected.objectType, cursor.objectType),
        gt(billingReconciliationCollected.providerObjectId, cursor.providerObjectId))) : undefined;
    const keys = await this.database.selectDistinct({ objectType: billingReconciliationCollected.objectType,
      providerObjectId: billingReconciliationCollected.providerObjectId }).from(billingReconciliationCollected)
      .where(and(eq(billingReconciliationCollected.runId, runId), after))
      .orderBy(asc(billingReconciliationCollected.objectType), asc(billingReconciliationCollected.providerObjectId)).limit(limit);
    if (!keys.length) return { rows: [] as LedgerComparisonRow[], nextCursor: null };
    const first = keys[0]!;
    const last = keys.at(-1)!;
    const through = or(lt(billingReconciliationCollected.objectType, last.objectType),
      and(eq(billingReconciliationCollected.objectType, last.objectType),
        lte(billingReconciliationCollected.providerObjectId, last.providerObjectId)));
    const fromFirst = or(gt(billingReconciliationCollected.objectType, first.objectType),
      and(eq(billingReconciliationCollected.objectType, first.objectType),
        sql`${billingReconciliationCollected.providerObjectId} >= ${first.providerObjectId}`));
    const values = await this.database.select().from(billingReconciliationCollected).where(and(
      eq(billingReconciliationCollected.runId, runId), fromFirst, through,
    )).orderBy(asc(billingReconciliationCollected.objectType), asc(billingReconciliationCollected.providerObjectId));
    const grouped = new Map<string, LedgerComparisonRow>();
    for (const value of values) {
      const key = `${value.objectType}\u0000${value.providerObjectId}`;
      const row = grouped.get(key) ?? { objectType: value.objectType as keyof LedgerSnapshot,
        providerObjectId: value.providerObjectId, provider: null, internal: null };
      row[value.side as "provider" | "internal"] = { id: value.providerObjectId,
        ...(value.objectStatus ? { status: value.objectStatus } : {}), ...(value.amount !== null ? { amount: value.amount } : {}) };
      grouped.set(key, row);
    }
    return { rows: [...grouped.values()], nextCursor: keys.length < limit ? null
      : Buffer.from(JSON.stringify({ t: last.objectType, i: last.providerObjectId }), "utf8").toString("base64url") };
  }

  async countDiscrepancies(runId: string) {
    const [{ count }] = await this.database.select({ count: sql<number>`count(*)` }).from(billingReconciliationItems)
      .where(eq(billingReconciliationItems.runId, runId));
    return Number(count);
  }

  async saveDiscrepancies(runId: string, rows: ReconciliationDiscrepancy[]) {
    if (rows.length > 400) throw new Error("RECONCILIATION_BATCH_TOO_LARGE");
    if (!rows.length) return;
    await this.database.insert(billingReconciliationItems).values(rows.map((row) => ({ runId, kind: row.kind,
      objectType: row.objectType, providerObjectId: row.providerObjectId,
      internalFingerprint: hash(row.internalFingerprint), providerFingerprint: hash(row.providerFingerprint) })))
      .onConflictDoNothing();
  }

  async completeRun(runId: string, nextCursor: string | null, leaseId?: string) {
    if (!leaseId) throw new Error("RECONCILIATION_LEASE_REQUIRED");
    const now = this.clock();
    const rows = await this.database.update(billingReconciliationRuns).set(nextCursor ? {
      status: "retry", cursor: nextCursor, leaseId: null, leaseExpiresAt: now, nextAttemptAt: now, updatedAt: now,
    } : { status: "completed", cursor: null, leaseId: null, leaseExpiresAt: now, completedAt: now, updatedAt: now })
      .where(and(eq(billingReconciliationRuns.id, runId), eq(billingReconciliationRuns.status, "running"),
        eq(billingReconciliationRuns.leaseId, leaseId))).returning({ id: billingReconciliationRuns.id });
    if (rows.length !== 1) throw new Error("RECONCILIATION_LEASE_LOST");
  }

  async failRun(runId: string, result: { retryable: boolean; errorCode: string }, leaseId?: string) {
    if (!leaseId) return;
    const now = this.clock();
    const [run] = await this.database.select({ attempts: billingReconciliationRuns.attempts })
      .from(billingReconciliationRuns).where(and(eq(billingReconciliationRuns.id, runId),
        eq(billingReconciliationRuns.leaseId, leaseId))).limit(1);
    if (!run) return;
    const attempts = run.attempts + 1;
    const terminal = !result.retryable || attempts >= 20;
    await this.database.update(billingReconciliationRuns).set({ status: terminal ? "failed" : "retry",
      leaseId: null, leaseExpiresAt: now, errorCode: result.errorCode, attempts,
      nextAttemptAt: terminal ? null : new Date(now.getTime() + Math.min(3_600_000, 1_000 * 2 ** Math.min(attempts, 11))),
      updatedAt: now }).where(and(eq(billingReconciliationRuns.id, runId), eq(billingReconciliationRuns.leaseId, leaseId)));
  }
}
