import { randomUUID } from "node:crypto";

import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm";

import { billingEntitlementOutbox, billingSubscriptions, entitlementUserPlanAssignments } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type BillingDatabase = typeof productionDatabase;
type RefreshJob = { id: string; leaseId: string; userId: string };
export interface EntitlementRefreshStore {
  claim(): Promise<RefreshJob | null>;
  applyProjection(id: string, leaseId: string): Promise<void>;
  complete(id: string, leaseId: string): Promise<void>;
  fail(id: string, leaseId: string, code: string): Promise<void>;
}

export class BillingEntitlementRefreshWorker {
  constructor(private readonly deps: {
    store: EntitlementRefreshStore; invalidate(userId: string): Promise<void>;
  }) {}

  async drain(limit = 10) {
    const bounded = Math.max(1, Math.min(50, Math.floor(limit)));
    let processed = 0;
    let failed = 0;
    for (let index = 0; index < bounded; index += 1) {
      const job = await this.deps.store.claim();
      if (!job) break;
      try {
        await this.deps.store.applyProjection(job.id, job.leaseId);
        await this.deps.invalidate(job.userId);
        await this.deps.store.complete(job.id, job.leaseId);
        processed += 1;
      } catch {
        await this.deps.store.fail(job.id, job.leaseId, "CACHE_INVALIDATION_FAILED");
        failed += 1;
      }
    }
    return { processed, failed };
  }
}

export class DrizzleEntitlementRefreshStore implements EntitlementRefreshStore {
  private readonly database: BillingDatabase;
  private readonly clock: () => Date;
  private readonly leaseMs: number;

  constructor(database: unknown, options: { clock?: () => Date; leaseMs?: number } = {}) {
    this.database = database as BillingDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  async claim() {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as BillingDatabase;
      const now = this.clock();
      const [candidate] = await tx.select().from(billingEntitlementOutbox).where(and(
        lt(billingEntitlementOutbox.attempts, 20),
        or(and(eq(billingEntitlementOutbox.status, "pending"), lte(billingEntitlementOutbox.availableAt, now)),
          and(eq(billingEntitlementOutbox.status, "leased"), lt(billingEntitlementOutbox.leaseExpiresAt, now))),
      )).orderBy(asc(billingEntitlementOutbox.availableAt), asc(billingEntitlementOutbox.id))
        .limit(1).for("update", { skipLocked: true });
      if (!candidate) return null;
      const leaseId = randomUUID();
      const [claimed] = await tx.update(billingEntitlementOutbox).set({ status: "leased", leaseId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs), attempts: sql`${billingEntitlementOutbox.attempts} + 1` })
        .where(and(eq(billingEntitlementOutbox.id, candidate.id), or(
          eq(billingEntitlementOutbox.status, "pending"),
          and(eq(billingEntitlementOutbox.status, "leased"), lt(billingEntitlementOutbox.leaseExpiresAt, now)),
        ))).returning({ id: billingEntitlementOutbox.id, userId: billingEntitlementOutbox.userId });
      return claimed ? { ...claimed, leaseId } : null;
    });
  }

  async applyProjection(id: string, leaseId: string) {
    await this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as BillingDatabase;
      const now = this.clock();
      const [job] = await tx.select().from(billingEntitlementOutbox).where(and(
        eq(billingEntitlementOutbox.id, id), eq(billingEntitlementOutbox.status, "leased"),
        eq(billingEntitlementOutbox.leaseId, leaseId), gtDate(billingEntitlementOutbox.leaseExpiresAt, now),
      )).for("update").limit(1);
      if (!job) throw new Error("ENTITLEMENT_REFRESH_LEASE_LOST");
      const [subscription] = job.subscriptionId ? await tx.select().from(billingSubscriptions)
        .where(eq(billingSubscriptions.id, job.subscriptionId)).limit(1) : [];
      const activeAssignments = await tx.select().from(entitlementUserPlanAssignments)
        .where(and(eq(entitlementUserPlanAssignments.userId, job.userId), eq(entitlementUserPlanAssignments.active, true)))
        .for("update");
      const entitled = subscription && (["trialing", "active"] as string[]).includes(subscription.status)
        || subscription?.status === "grace_period" && !!subscription.graceEndsAt && subscription.graceEndsAt > now;
      const expiresAt = subscription?.status === "grace_period" ? subscription.graceEndsAt : subscription?.currentPeriodEnd ?? null;
      const alreadyProjected = entitled && activeAssignments.length === 1
        && activeAssignments[0]!.planRef === subscription!.planRef
        && activeAssignments[0]!.expiresAt?.getTime() === expiresAt?.getTime();
      if (alreadyProjected) return;
      for (const assignment of activeAssignments) {
        const safeExpiry = now > assignment.effectiveAt ? now : new Date(assignment.effectiveAt.getTime() + 1);
        await tx.update(entitlementUserPlanAssignments).set({ active: false,
          expiresAt: assignment.expiresAt && assignment.expiresAt < safeExpiry ? assignment.expiresAt : safeExpiry })
          .where(eq(entitlementUserPlanAssignments.id, assignment.id));
      }
      if (entitled) {
        const [{ version }] = await tx.select({ version: sql<number>`coalesce(max(${entitlementUserPlanAssignments.version}), 0)` })
          .from(entitlementUserPlanAssignments).where(eq(entitlementUserPlanAssignments.userId, job.userId));
        await tx.insert(entitlementUserPlanAssignments).values({ userId: job.userId, planRef: subscription!.planRef,
          version: Number(version) + 1, active: true, effectiveAt: now, expiresAt, createdAt: now });
      }
    });
  }

  async complete(id: string, leaseId: string) {
    const rows = await this.database.update(billingEntitlementOutbox).set({ status: "done", leaseId: null,
      leaseExpiresAt: null, processedAt: this.clock() }).where(and(eq(billingEntitlementOutbox.id, id),
      eq(billingEntitlementOutbox.status, "leased"), eq(billingEntitlementOutbox.leaseId, leaseId)))
      .returning({ id: billingEntitlementOutbox.id });
    if (rows.length !== 1) throw new Error("ENTITLEMENT_REFRESH_LEASE_LOST");
  }

  async fail(id: string, leaseId: string, code: string) {
    const now = this.clock();
    const [row] = await this.database.select({ attempts: billingEntitlementOutbox.attempts })
      .from(billingEntitlementOutbox).where(and(eq(billingEntitlementOutbox.id, id),
        eq(billingEntitlementOutbox.leaseId, leaseId))).limit(1);
    if (!row) return;
    const failed = row.attempts >= 20;
    await this.database.update(billingEntitlementOutbox).set({ status: failed ? "failed" : "pending",
      leaseId: null, leaseExpiresAt: null,
      availableAt: new Date(now.getTime() + Math.min(3_600_000, 1_000 * 2 ** Math.min(row.attempts, 11))) })
      .where(and(eq(billingEntitlementOutbox.id, id), eq(billingEntitlementOutbox.leaseId, leaseId)));
    void code;
  }
}

const gtDate = (column: typeof billingEntitlementOutbox.leaseExpiresAt, date: Date) =>
  and(sql`${column} IS NOT NULL`, sql`${column} > ${date}`)!;
