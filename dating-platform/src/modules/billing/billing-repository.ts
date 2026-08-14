import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import {
  billingCustomers, billingDisputes, billingEntitlementOutbox, billingInvoicePaymentLinks, billingOrders, billingPayments,
  billingPlans, billingPrices, billingRefunds, billingSubscriptionIntents, billingSubscriptions, billingWebhookEvents, users,
} from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import { BillingError, type BillingPrice, type CheckoutStore } from "./checkout-service";
import type { BillingEventStore, NormalizedBillingEvent } from "./webhook-service";

type BillingDatabase = typeof productionDatabase;
type ProviderSubscriptionStatus = "trialing" | "active" | "past_due" | "grace_period" | "canceled" | "expired";
type EntitlementOverride = "none" | "dispute_open" | "dispute_lost" | "refund_full" | "duplicate_subscription";
const effectiveSubscriptionStatus = (providerStatus: ProviderSubscriptionStatus, override: EntitlementOverride) =>
  override === "dispute_open" ? "disputed" : override === "dispute_lost" ? "revoked"
    : override === "refund_full" ? "expired" : override === "duplicate_subscription" ? "revoked" : providerStatus;
const subscriptionSafetyRank = (status: string) => {
  if (status === "disputed" || status === "canceled" || status === "expired") return 3;
  if (status === "past_due" || status === "grace_period") return 2;
  return 1;
};

export class DrizzleBillingRepository implements CheckoutStore, BillingEventStore {
  private readonly database: BillingDatabase;
  private readonly clock: () => Date;
  private readonly gracePeriodMs: number;

  constructor(database: unknown, options: { clock?: () => Date; gracePeriodMs?: number } = {}) {
    this.database = database as BillingDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.gracePeriodMs = options.gracePeriodMs ?? 3 * 86_400_000;
  }

  async listPrices(input: { countryCode: string; currency: string; now: Date; limit: number; after?: string }) {
    const rows = await this.database.selectDistinctOn([billingPlans.planRef], { price: billingPrices, plan: billingPlans })
      .from(billingPrices).innerJoin(billingPlans, eq(billingPlans.id, billingPrices.planId))
      .where(and(eq(billingPrices.countryCode, input.countryCode), eq(billingPrices.currency, input.currency),
        eq(billingPrices.active, true), eq(billingPlans.active, true), lte(billingPrices.effectiveAt, input.now),
        lte(billingPlans.effectiveAt, input.now), or(isNull(billingPrices.expiresAt), gt(billingPrices.expiresAt, input.now)),
        or(isNull(billingPlans.expiresAt), gt(billingPlans.expiresAt, input.now)),
        input.after ? gt(billingPlans.planRef, input.after) : undefined))
      .orderBy(billingPlans.planRef, desc(billingPlans.version), desc(billingPrices.version),
        desc(billingPrices.effectiveAt), desc(billingPrices.id)).limit(input.limit);
    return rows.map(({ price, plan }) => this.mapPrice(price, plan));
  }

  async selectPrice(input: { planRef: string; countryCode: string; currency?: string; now: Date }) {
    const rows = await this.database.select({ price: billingPrices, plan: billingPlans })
      .from(billingPrices).innerJoin(billingPlans, eq(billingPlans.id, billingPrices.planId))
      .where(and(eq(billingPlans.planRef, input.planRef), eq(billingPrices.countryCode, input.countryCode),
        eq(billingPrices.active, true), eq(billingPlans.active, true),
        lte(billingPrices.effectiveAt, input.now), lte(billingPlans.effectiveAt, input.now),
        or(isNull(billingPrices.expiresAt), gt(billingPrices.expiresAt, input.now)),
        or(isNull(billingPlans.expiresAt), gt(billingPlans.expiresAt, input.now))))
      .orderBy(desc(billingPlans.version), desc(billingPrices.version),
        desc(billingPrices.effectiveAt), desc(billingPrices.id)).limit(1);
    if (rows.length === 0) return null;
    return this.mapPrice(rows[0]!.price, rows[0]!.plan);
  }

  async createOrGetPendingOrder(input: {
    userId: string; idempotencyKey: string; requestHash: string; price: BillingPrice;
  }) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as BillingDatabase;
      await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id} = ${input.userId} FOR UPDATE`);
      const [current] = await tx.select({ id: billingSubscriptions.id }).from(billingSubscriptions)
        .where(and(eq(billingSubscriptions.userId, input.userId), inArray(billingSubscriptions.status,
          ["trialing", "active", "past_due", "grace_period", "disputed"]))).limit(1);
      if (current) throw new BillingError("CHECKOUT_NOT_AVAILABLE");
      const [sameRequest] = await tx.select().from(billingOrders)
        .where(and(eq(billingOrders.userId, input.userId), eq(billingOrders.idempotencyKey, input.idempotencyKey))).limit(1);
      if (sameRequest) {
        if (sameRequest.requestHash !== input.requestHash || sameRequest.priceId !== input.price.id) {
          throw new BillingError("IDEMPOTENCY_CONFLICT");
        }
        return { created: false, order: { id: sameRequest.id, userId: sameRequest.userId, price: input.price,
          providerSessionId: sameRequest.providerSessionId, checkoutUrl: sameRequest.checkoutUrl } };
      }
      const [openOrder] = await tx.select({ id: billingOrders.id }).from(billingOrders)
        .where(and(eq(billingOrders.userId, input.userId), inArray(billingOrders.status, ["pending", "session_created"]))).limit(1);
      if (openOrder) throw new BillingError("CHECKOUT_NOT_AVAILABLE");
      const now = this.clock();
      const [row] = await tx.insert(billingOrders).values({
        userId: input.userId, priceId: input.price.id, idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash, planRef: input.price.planRef, planVersion: input.price.planVersion,
        amount: input.price.unitAmount, currency: input.price.currency, createdAt: now, updatedAt: now,
      }).returning();
      if (!row) throw new BillingError("CHECKOUT_NOT_AVAILABLE");
      return { created: true, order: { id: row.id, userId: row.userId, price: input.price,
        providerSessionId: row.providerSessionId, checkoutUrl: row.checkoutUrl } };
    });
  }

  async assertCustomerOwnership(userId: string) {
    const rows = await this.database.select({ userId: billingCustomers.userId }).from(billingCustomers)
      .where(eq(billingCustomers.userId, userId)).limit(2);
    if (rows.length > 1 || (rows[0] && rows[0].userId !== userId)) throw new BillingError("CUSTOMER_NOT_AVAILABLE");
    if (!rows[0]) return;
    const [customer] = await this.database.select({ id: billingCustomers.providerCustomerId }).from(billingCustomers)
      .where(eq(billingCustomers.userId, userId)).limit(1);
    return customer?.id;
  }

  async getOwnedSubscription(userId: string) {
    const [row] = await this.database.select().from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId))
      .orderBy(desc(billingSubscriptions.updatedAt), desc(billingSubscriptions.id)).limit(1);
    return row ? { id: row.id, planRef: row.planRef, status: row.status, currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd, providerSubscriptionId: row.providerSubscriptionId } : null;
  }

  async createOrGetIntent(input: { userId: string; subscriptionId: string;
    action: "cancel_at_period_end" | "resume"; idempotencyKey: string; requestHash: string }) {
    const [owned] = await this.database.select({ id: billingSubscriptions.id,
      providerSubscriptionId: billingSubscriptions.providerSubscriptionId,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd }).from(billingSubscriptions)
      .where(and(eq(billingSubscriptions.id, input.subscriptionId), eq(billingSubscriptions.userId, input.userId))).limit(1);
    if (!owned) throw new BillingError("SUBSCRIPTION_NOT_AVAILABLE");
    const now = this.clock();
    const inserted = await this.database.insert(billingSubscriptionIntents).values({ userId: input.userId,
      subscriptionId: input.subscriptionId, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash,
      action: input.action, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [billingSubscriptionIntents.userId, billingSubscriptionIntents.idempotencyKey] })
      .returning();
    const [row] = inserted.length ? inserted : await this.database.select().from(billingSubscriptionIntents)
      .where(and(eq(billingSubscriptionIntents.userId, input.userId),
        eq(billingSubscriptionIntents.idempotencyKey, input.idempotencyKey))).limit(1);
    if (!row || row.subscriptionId !== input.subscriptionId || row.requestHash !== input.requestHash
      || row.action !== input.action) throw new BillingError("IDEMPOTENCY_CONFLICT");
    return { created: inserted.length === 1, intent: { id: row.id,
      status: row.status as "pending" | "provider_submitted" | "failed",
      action: row.action as "cancel_at_period_end" | "resume", providerSubscriptionId: owned.providerSubscriptionId,
      cancelAtPeriodEnd: owned.cancelAtPeriodEnd } };
  }

  async beginIntentAttempt(id: string) {
    const rows = await this.database.update(billingSubscriptionIntents)
      .set({ attempts: sql`${billingSubscriptionIntents.attempts} + 1`, status: "pending", updatedAt: this.clock() })
      .where(and(eq(billingSubscriptionIntents.id, id), lt(billingSubscriptionIntents.attempts, 20),
        or(eq(billingSubscriptionIntents.status, "pending"), eq(billingSubscriptionIntents.status, "failed"))))
      .returning({ id: billingSubscriptionIntents.id });
    return rows.length === 1;
  }

  async markIntentSubmitted(id: string) {
    const rows = await this.database.update(billingSubscriptionIntents).set({ status: "provider_submitted", updatedAt: this.clock() })
      .where(and(eq(billingSubscriptionIntents.id, id), eq(billingSubscriptionIntents.status, "pending")))
      .returning({ id: billingSubscriptionIntents.id });
    if (rows.length !== 1) throw new Error("BILLING_SUBSCRIPTION_INTENT_STATE_INVALID");
  }

  async markIntentFailed(id: string) {
    await this.database.update(billingSubscriptionIntents).set({ status: "failed", updatedAt: this.clock() })
      .where(and(eq(billingSubscriptionIntents.id, id), eq(billingSubscriptionIntents.status, "pending")));
  }

  async attachProviderSession(orderId: string, session: { id: string; url: string }) {
    const rows = await this.database.update(billingOrders).set({ providerSessionId: session.id,
      checkoutUrl: session.url, status: "session_created", updatedAt: this.clock() })
      .where(and(eq(billingOrders.id, orderId), or(eq(billingOrders.status, "pending"),
        and(eq(billingOrders.status, "session_created"), eq(billingOrders.providerSessionId, session.id)))))
      .returning({ id: billingOrders.id });
    if (rows.length !== 1) throw new BillingError("IDEMPOTENCY_CONFLICT");
  }

  async recordProviderFailure(orderId: string) {
    await this.database.update(billingOrders).set({
      providerFailureCount: sql`${billingOrders.providerFailureCount} + 1`, updatedAt: this.clock(),
    }).where(and(eq(billingOrders.id, orderId), sql`${billingOrders.providerFailureCount} < 100`));
  }

  async applyEvent(event: NormalizedBillingEvent, payloadHash: string) {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as BillingDatabase;
      const now = this.clock();
      const claimed = await tx.insert(billingWebhookEvents).values({ providerEventId: event.id,
        eventType: event.type, payloadHash, objectId: event.objectId, providerCreatedAt: event.createdAt,
        outcome: "processing", reviewReason: event.reviewReason, processedAt: now })
        .onConflictDoNothing().returning({ id: billingWebhookEvents.providerEventId });
      if (claimed.length === 0) return { duplicate: true, outcome: "duplicate" as const };
      let outcome: "applied" | "stale" | "ignored" = "ignored";
      if (event.type === "invoice.paid") outcome = await this.applyInvoicePaid(tx, event, now);
      else if (event.type === "invoice.payment_failed") outcome = await this.applyInvoiceFailed(tx, event, now);
      else if (event.type === "subscription.created" || event.type === "subscription.updated") {
        outcome = await this.applySubscription(tx, event, event.subscriptionStatus ?? "expired", now);
      } else if (event.type === "subscription.deleted") outcome = await this.applySubscription(tx, event, "canceled", now);
      else if (event.type === "unknown" && event.providerSubscriptionId
        && event.reviewReason?.startsWith("UNKNOWN_SUBSCRIPTION_STATUS:")) {
        outcome = await this.applySubscription(tx, event, "expired", now);
      }
      else if (event.type === "refund.created") outcome = await this.applyRefund(tx, event, now);
      else if (event.type === "dispute.created" || event.type === "dispute.closed") {
        outcome = await this.applyDispute(tx, event, now);
      }
      await tx.update(billingWebhookEvents).set({ outcome, processedAt: now })
        .where(eq(billingWebhookEvents.providerEventId, event.id));
      return { duplicate: false, outcome };
    });
  }

  private async applyInvoicePaid(tx: BillingDatabase, event: NormalizedBillingEvent, now: Date) {
    this.requireMoney(event);
    if (!event.providerInvoiceId) throw new Error("BILLING_EVENT_REFERENCE_INVALID");
    const existingPayment = await tx.select({ id: billingPayments.id }).from(billingPayments)
      .where(eq(billingPayments.providerInvoiceId, event.providerInvoiceId)).limit(1);
    if (existingPayment.length) return "ignored" as const;
    const resolved = await this.resolveSubscription(tx, event, "active", now, null, true);
    if (event.currency !== resolved.order.currency || event.amount !== resolved.order.amount) {
      throw new Error("BILLING_AMOUNT_MISMATCH");
    }
    const [payment] = await tx.insert(billingPayments).values({ orderId: resolved.order.id, subscriptionId: resolved.subscription.id,
      providerInvoiceId: event.providerInvoiceId, providerInvoicePaymentId: event.providerInvoicePaymentId,
      providerPaymentId: event.providerPaymentId, providerChargeId: event.providerChargeId,
      providerEventId: event.id, amount: event.amount!, currency: event.currency!, paidAt: event.createdAt, createdAt: now })
      .returning({ id: billingPayments.id });
    const links = event.paymentLinks?.length ? event.paymentLinks
      : event.providerInvoicePaymentId && (event.providerPaymentId || event.providerChargeId) ? [{
        providerInvoicePaymentId: event.providerInvoicePaymentId,
        providerPaymentId: event.providerPaymentId,
        providerChargeId: event.providerChargeId ?? null,
      }] : [];
    const uniqueLinks = [...new Map(links.map((link) => [link.providerInvoicePaymentId, link])).values()];
    if (uniqueLinks.length) await tx.insert(billingInvoicePaymentLinks).values(uniqueLinks.map((link) => ({
      paymentId: payment!.id, providerInvoicePaymentId: link.providerInvoicePaymentId,
      providerPaymentId: link.providerPaymentId, providerChargeId: link.providerChargeId, createdAt: now,
    })));
    if (resolved.reviewRequired) {
      await this.markDuplicateReview(tx, event, resolved.order.id, now);
      return "ignored" as const;
    }
    if (resolved.stale) return "stale" as const;
    await tx.update(billingSubscriptions).set({ currentEntitlementPaymentId: payment!.id, updatedAt: now })
      .where(eq(billingSubscriptions.id, resolved.subscription.id));
    await tx.update(billingOrders).set({ status: "paid", updatedAt: now }).where(eq(billingOrders.id, resolved.order.id));
    await this.enqueueEntitlement(tx, event, resolved.subscription.id, resolved.subscription.userId, now);
    return "applied" as const;
  }

  private async applyInvoiceFailed(tx: BillingDatabase, event: NormalizedBillingEvent, now: Date) {
    const resolved = await this.resolveSubscription(tx, event, "grace_period", now,
      new Date(now.getTime() + this.gracePeriodMs));
    if (resolved.stale) return "stale" as const;
    if (resolved.reviewRequired) {
      await this.markDuplicateReview(tx, event, resolved.order.id, now);
      return "ignored" as const;
    }
    await this.enqueueEntitlement(tx, event, resolved.subscription.id, resolved.subscription.userId, now);
    return "applied" as const;
  }

  private async applySubscription(tx: BillingDatabase, event: NormalizedBillingEvent,
    status: "trialing" | "active" | "past_due" | "canceled" | "expired", now: Date) {
    const resolved = await this.resolveSubscription(tx, event, status, now);
    if (resolved.stale) return "stale" as const;
    if (resolved.reviewRequired) {
      await this.markDuplicateReview(tx, event, resolved.order.id, now);
      return "ignored" as const;
    }
    await this.enqueueEntitlement(tx, event, resolved.subscription.id, resolved.subscription.userId, now);
    return "applied" as const;
  }

  private async applyRefund(tx: BillingDatabase, event: NormalizedBillingEvent, now: Date) {
    this.requireMoney(event);
    if (!event.providerRefundId
      || (!event.providerInvoicePaymentId && !event.providerPaymentId && !event.providerChargeId)) {
      throw new Error("BILLING_EVENT_REFERENCE_INVALID");
    }
    const paymentResolution = await this.findPayment(tx, event, true);
    if (paymentResolution.ambiguous) {
      await this.markAmbiguousPaymentReview(tx, event);
      return "ignored" as const;
    }
    const payment = paymentResolution.payment;
    if (!payment || payment.currency !== event.currency) throw new Error("BILLING_PAYMENT_NOT_AVAILABLE");
    const [subscription] = payment.subscriptionId ? await tx.select().from(billingSubscriptions)
      .where(eq(billingSubscriptions.id, payment.subscriptionId)).for("update").limit(1) : [];
    const [order] = payment.orderId ? await tx.select().from(billingOrders)
      .where(eq(billingOrders.id, payment.orderId)).for("update").limit(1) : [];
    const existing = await tx.select().from(billingRefunds)
      .where(eq(billingRefunds.providerRefundId, event.providerRefundId)).limit(1);
    if (existing.length) return "ignored" as const;
    await tx.insert(billingRefunds).values({ paymentId: payment.id, providerRefundId: event.providerRefundId,
      providerEventId: event.id, amount: event.amount!, currency: event.currency!, createdAt: now });
    const [{ total }] = await tx.select({ total: sql<number>`coalesce(sum(${billingRefunds.amount}), 0)` })
      .from(billingRefunds).where(eq(billingRefunds.paymentId, payment.id));
    if (Number(total) > payment.amount) throw new Error("BILLING_REFUND_AMOUNT_INVALID");
    const duplicateSubscription = subscription?.entitlementOverride === "duplicate_subscription";
    let entitlementChanged = false;
    if (Number(total) === payment.amount) {
      if (order) await tx.update(billingOrders).set({ status: "refunded", updatedAt: now })
        .where(and(eq(billingOrders.id, order.id), ne(billingOrders.status, "refunded")));
      if (subscription && !duplicateSubscription) {
        const updated = await tx.update(billingSubscriptions).set({ status: "expired",
        entitlementOverride: "refund_full", updatedAt: now })
        .where(and(eq(billingSubscriptions.id, subscription.id),
          eq(billingSubscriptions.currentEntitlementPaymentId, payment.id),
          lte(billingSubscriptions.providerObjectVersion, event.objectVersion),
          lte(billingSubscriptions.providerEventCreatedAt, event.createdAt),
          ne(billingSubscriptions.entitlementOverride, "refund_full"))).returning({ id: billingSubscriptions.id });
        entitlementChanged = updated.length === 1;
      }
    }
    if (subscription && entitlementChanged) await this.enqueueEntitlement(tx, event, subscription.id, subscription.userId, now);
    return "applied" as const;
  }

  private async applyDispute(tx: BillingDatabase, event: NormalizedBillingEvent, now: Date) {
    this.requireMoney(event);
    if (!event.providerDisputeId
      || (!event.providerInvoicePaymentId && !event.providerPaymentId && !event.providerChargeId)) {
      throw new Error("BILLING_EVENT_REFERENCE_INVALID");
    }
    const paymentResolution = await this.findPayment(tx, event);
    if (paymentResolution.ambiguous) {
      await this.markAmbiguousPaymentReview(tx, event);
      return "ignored" as const;
    }
    const payment = paymentResolution.payment;
    if (!payment || payment.currency !== event.currency) throw new Error("BILLING_PAYMENT_NOT_AVAILABLE");
    const [existing] = await tx.select().from(billingDisputes)
      .where(eq(billingDisputes.providerDisputeId, event.providerDisputeId)).limit(1);
    const [subscription] = payment.subscriptionId ? await tx.select().from(billingSubscriptions)
      .where(eq(billingSubscriptions.id, payment.subscriptionId)).limit(1) : [];
    const [order] = payment.orderId ? await tx.select().from(billingOrders)
      .where(eq(billingOrders.id, payment.orderId)).limit(1) : [];
    const userId = subscription?.userId ?? order?.userId ?? event.userId;
    if (!userId) throw new Error("BILLING_OWNER_NOT_AVAILABLE");
    const duplicateSubscription = subscription?.entitlementOverride === "duplicate_subscription";
    const fullRefund = subscription?.entitlementOverride === "refund_full" || order?.status === "refunded";
    let entitlementChanged = false;
    if (event.type === "dispute.created") {
      if (existing) return "ignored" as const;
      await tx.insert(billingDisputes).values({ paymentId: payment.id, userId,
        providerDisputeId: event.providerDisputeId, providerEventId: event.id,
        amount: event.amount!, currency: event.currency!, status: "needs_review",
        previousSubscriptionStatus: subscription?.status, createdAt: now });
      if (order && !duplicateSubscription && !fullRefund && order.status !== "review_required") {
        await tx.update(billingOrders).set({ status: "disputed", updatedAt: now })
          .where(eq(billingOrders.id, order.id));
      }
      if (subscription && !["refund_full", "dispute_lost", "duplicate_subscription"]
        .includes(subscription.entitlementOverride)) {
        const updated = await tx.update(billingSubscriptions)
          .set({ status: "disputed", entitlementOverride: "dispute_open", updatedAt: now })
          .where(eq(billingSubscriptions.id, subscription.id)).returning({ id: billingSubscriptions.id });
        entitlementChanged = updated.length === 1;
      }
    } else {
      if (!existing || (event.disputeStatus !== "won" && event.disputeStatus !== "lost")) {
        throw new Error("BILLING_DISPUTE_STATE_INVALID");
      }
      await tx.update(billingDisputes).set({ status: event.disputeStatus })
        .where(eq(billingDisputes.id, existing.id));
      if (event.disputeStatus === "won") {
        if (order && !duplicateSubscription && !fullRefund && order.status !== "review_required") {
          await tx.update(billingOrders).set({ status: "paid", updatedAt: now })
            .where(eq(billingOrders.id, order.id));
        }
        if (subscription?.entitlementOverride === "dispute_open") {
          const updated = await tx.update(billingSubscriptions).set({ status: subscription.providerStatus,
            entitlementOverride: "none", updatedAt: now }).where(eq(billingSubscriptions.id, subscription.id))
            .returning({ id: billingSubscriptions.id });
          entitlementChanged = updated.length === 1;
        }
      } else if (subscription && subscription.entitlementOverride !== "refund_full"
        && subscription.entitlementOverride !== "duplicate_subscription"
        && subscription.entitlementOverride !== "dispute_lost") {
        const updated = await tx.update(billingSubscriptions)
          .set({ status: "revoked", entitlementOverride: "dispute_lost", updatedAt: now })
          .where(eq(billingSubscriptions.id, subscription.id)).returning({ id: billingSubscriptions.id });
        entitlementChanged = updated.length === 1;
      }
    }
    if (duplicateSubscription && order) await this.markDuplicateReview(tx, event, order.id, now);
    if (subscription && entitlementChanged) await this.enqueueEntitlement(tx, event, subscription.id, subscription.userId, now);
    return "applied" as const;
  }

  private async findPayment(tx: BillingDatabase, event: NormalizedBillingEvent, lock = false) {
    const load = async (candidateIds: Set<string>) => {
      if (candidateIds.size !== 1) return { payment: null, ambiguous: candidateIds.size > 1 };
      const [paymentId] = candidateIds;
      const query = tx.select().from(billingPayments).where(eq(billingPayments.id, paymentId!));
      const [payment] = lock ? await query.for("update").limit(1) : await query.limit(1);
      return { payment: payment ?? null, ambiguous: false };
    };
    const candidates = async (kind: "charge" | "payment", value: string) => {
      const relationColumn = kind === "charge" ? billingInvoicePaymentLinks.providerChargeId
        : billingInvoicePaymentLinks.providerPaymentId;
      const paymentColumn = kind === "charge" ? billingPayments.providerChargeId : billingPayments.providerPaymentId;
      const relationRows = await tx.select({ paymentId: billingInvoicePaymentLinks.paymentId })
        .from(billingInvoicePaymentLinks).where(eq(relationColumn, value)).limit(2);
      const directRows = await tx.select({ paymentId: billingPayments.id }).from(billingPayments)
        .where(eq(paymentColumn, value)).limit(2);
      return new Set([...relationRows, ...directRows].map((row) => row.paymentId));
    };
    if (event.providerInvoicePaymentId) {
      const relations = await tx.select({ paymentId: billingInvoicePaymentLinks.paymentId })
        .from(billingInvoicePaymentLinks)
        .where(eq(billingInvoicePaymentLinks.providerInvoicePaymentId, event.providerInvoicePaymentId)).limit(2);
      return load(new Set(relations.map((row) => row.paymentId)));
    }
    if (event.providerChargeId) {
      const chargeCandidates = await candidates("charge", event.providerChargeId);
      if (chargeCandidates.size === 1) return load(chargeCandidates);
      if (chargeCandidates.size > 1) {
        if (!event.providerPaymentId) return { payment: null, ambiguous: true };
        const paymentCandidates = await candidates("payment", event.providerPaymentId);
        const intersection = new Set([...chargeCandidates].filter((id) => paymentCandidates.has(id)));
        return load(intersection.size ? intersection : chargeCandidates);
      }
    }
    if (event.providerPaymentId) return load(await candidates("payment", event.providerPaymentId));
    return { payment: null, ambiguous: false };
  }

  private async markAmbiguousPaymentReview(tx: BillingDatabase, event: NormalizedBillingEvent) {
    await tx.update(billingWebhookEvents).set({ reviewReason: "AMBIGUOUS_PAYMENT_REFERENCE" })
      .where(eq(billingWebhookEvents.providerEventId, event.id));
  }

  private async resolveSubscription(tx: BillingDatabase, event: NormalizedBillingEvent,
    status: ProviderSubscriptionStatus, now: Date, graceEndsAt: Date | null = null, clearRefundOverride = false) {
    if (!event.providerSubscriptionId) throw new Error("BILLING_SUBSCRIPTION_REFERENCE_INVALID");
    const [existing] = await tx.select().from(billingSubscriptions)
      .where(eq(billingSubscriptions.providerSubscriptionId, event.providerSubscriptionId)).limit(1);
    if (existing) {
      const [order] = existing.orderId ? await tx.select().from(billingOrders).where(eq(billingOrders.id, existing.orderId)).limit(1) : [];
      if (!order) throw new Error("BILLING_ORDER_NOT_AVAILABLE");
      if (event.objectVersion < existing.providerObjectVersion || event.createdAt < existing.providerEventCreatedAt) {
        return { subscription: existing, order, stale: true,
          reviewRequired: existing.entitlementOverride === "duplicate_subscription" };
      }
      const sameProviderInstant = event.objectVersion === existing.providerObjectVersion
        && event.createdAt.getTime() === existing.providerEventCreatedAt.getTime();
      if (sameProviderInstant && subscriptionSafetyRank(status) < subscriptionSafetyRank(existing.providerStatus)) {
        return { subscription: existing, order, stale: true,
          reviewRequired: existing.entitlementOverride === "duplicate_subscription" };
      }
      const currentOverride = existing.entitlementOverride as EntitlementOverride;
      const nextOverride = clearRefundOverride && currentOverride === "refund_full" ? "none" : currentOverride;
      const [updated] = await tx.update(billingSubscriptions).set({
        status: effectiveSubscriptionStatus(status, nextOverride), providerStatus: status, entitlementOverride: nextOverride,
        providerObjectVersion: event.objectVersion, providerEventCreatedAt: event.createdAt,
        currentPeriodStart: event.periodStart ?? existing.currentPeriodStart,
        currentPeriodEnd: event.periodEnd ?? existing.currentPeriodEnd,
        graceEndsAt, cancelAtPeriodEnd: event.cancelAtPeriodEnd ?? existing.cancelAtPeriodEnd,
        updatedAt: now }).where(eq(billingSubscriptions.id, existing.id)).returning();
      return { subscription: updated!, order, stale: false,
        reviewRequired: nextOverride === "duplicate_subscription" };
    }
    if (!event.userId || !event.orderId || !event.providerCustomerId) throw new Error("BILLING_OWNER_NOT_AVAILABLE");
    const [order] = await tx.select().from(billingOrders).where(and(eq(billingOrders.id, event.orderId),
      eq(billingOrders.userId, event.userId))).limit(1);
    if (!order) throw new Error("BILLING_ORDER_NOT_AVAILABLE");
    await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id} = ${event.userId} FOR UPDATE`);
    const [current] = await tx.select({ id: billingSubscriptions.id }).from(billingSubscriptions)
      .where(and(eq(billingSubscriptions.userId, event.userId), inArray(billingSubscriptions.status,
        ["trialing", "active", "past_due", "grace_period", "disputed"]))).limit(1);
    await tx.insert(billingCustomers).values({ userId: event.userId, providerCustomerId: event.providerCustomerId,
      createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [customer] = await tx.select().from(billingCustomers).where(and(eq(billingCustomers.userId, event.userId),
      eq(billingCustomers.providerCustomerId, event.providerCustomerId))).limit(1);
    if (!customer) throw new Error("BILLING_CUSTOMER_OWNERSHIP_INVALID");
    const entitlementOverride: EntitlementOverride = current ? "duplicate_subscription" : "none";
    const [subscription] = await tx.insert(billingSubscriptions).values({ userId: event.userId,
      orderId: order.id, priceId: order.priceId, planRef: order.planRef,
      providerCustomerId: event.providerCustomerId, providerSubscriptionId: event.providerSubscriptionId,
      status: effectiveSubscriptionStatus(status, entitlementOverride), providerStatus: status, entitlementOverride,
      providerObjectVersion: event.objectVersion, providerEventCreatedAt: event.createdAt,
      currentPeriodStart: event.periodStart, currentPeriodEnd: event.periodEnd, graceEndsAt,
      cancelAtPeriodEnd: event.cancelAtPeriodEnd ?? false,
      createdAt: now, updatedAt: now }).returning();
    return { subscription: subscription!, order, stale: false, reviewRequired: Boolean(current) };
  }

  private async markDuplicateReview(tx: BillingDatabase, event: NormalizedBillingEvent, orderId: string, now: Date) {
    await tx.update(billingOrders).set({ status: "review_required", updatedAt: now }).where(eq(billingOrders.id, orderId));
    await tx.update(billingWebhookEvents).set({ reviewReason: "DUPLICATE_SUBSCRIPTION_REQUIRES_COMPENSATION" })
      .where(eq(billingWebhookEvents.providerEventId, event.id));
  }

  private async enqueueEntitlement(tx: BillingDatabase, event: NormalizedBillingEvent,
    subscriptionId: string, userId: string, now: Date) {
    await tx.insert(billingEntitlementOutbox).values({ userId, subscriptionId, sourceEventId: event.id,
      availableAt: now, createdAt: now }).onConflictDoNothing();
  }

  private requireMoney(event: NormalizedBillingEvent) {
    if (event.amount === null || !Number.isSafeInteger(event.amount) || event.amount < 0 || event.amount > 1_000_000_000
      || !event.currency || !/^[A-Z]{3}$/u.test(event.currency)) throw new Error("BILLING_MONEY_INVALID");
  }

  private mapPrice(price: typeof billingPrices.$inferSelect, plan: typeof billingPlans.$inferSelect): BillingPrice {
    return { id: price.id, planRef: plan.planRef, planVersion: plan.version, priceVersion: price.version,
      planNameKey: plan.nameKey, planDescriptionKey: plan.descriptionKey, providerPriceId: price.providerPriceId,
      countryCode: price.countryCode, currency: price.currency, unitAmount: price.unitAmount,
      interval: price.interval as BillingPrice["interval"], intervalCount: price.intervalCount,
      taxMode: price.taxMode as BillingPrice["taxMode"], active: price.active && plan.active,
      effectiveAt: price.effectiveAt, expiresAt: price.expiresAt };
  }
}
