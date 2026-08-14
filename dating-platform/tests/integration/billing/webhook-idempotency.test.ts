// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleBillingRepository } from "@/modules/billing/billing-repository";
import { DrizzleReconciliationStore } from "@/modules/billing/reconciliation-repository";
import { ReconciliationService } from "@/modules/billing/reconciliation-service";
import { BillingError, ProviderEnrichmentError, WebhookService,
  type NormalizedBillingEvent } from "@/modules/billing/webhook-service";
import { BillingEntitlementRefreshWorker, DrizzleEntitlementRefreshStore } from "@/workers/billing-entitlement-worker";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000001";

describe("billing ledger and webhook idempotency", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let repository: DrizzleBillingRepository;
  let orderId: string;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "drizzle" });
    repository = new DrizzleBillingRepository(database, { clock: () => NOW, gracePeriodMs: 3 * 86_400_000 });
    await database.insert(schema.users).values({ id: USER_ID, name: "Billing User", email: "billing@example.test", emailVerified: true });
    const [plan] = await database.insert(schema.billingPlans).values({ planRef: "plus", version: 1,
      nameKey: "plans.plus.name", descriptionKey: "plans.plus.description", effectiveAt: new Date("2026-01-01") }).returning();
    const [price] = await database.insert(schema.billingPrices).values({ planId: plan.id, version: 1,
      countryCode: "US", currency: "USD", unitAmount: 1299, interval: "monthly", intervalCount: 1,
      taxMode: "exclusive", providerPriceId: "price_1", effectiveAt: new Date("2026-01-01") }).returning();
    const created = await repository.createOrGetPendingOrder({ userId: USER_ID, idempotencyKey: "idem-0001",
      requestHash: "a".repeat(64), price: { id: price.id, planRef: "plus", planVersion: 1,
        planNameKey: "plans.plus.name", planDescriptionKey: "plans.plus.description", providerPriceId: "price_1",
        countryCode: "US", currency: "USD", unitAmount: 1299, interval: "monthly", intervalCount: 1,
        taxMode: "exclusive", active: true, effectiveAt: new Date("2026-01-01"), expiresAt: null } });
    orderId = created.order.id;
  }, 60_000);

  afterEach(async () => client.close());

  const invoice = (id = "evt_paid", version = 100): NormalizedBillingEvent => ({
    id, type: "invoice.paid", createdAt: new Date(NOW.getTime() + version * 1_000), objectId: "in_1", objectVersion: version,
    userId: USER_ID, orderId, providerCustomerId: "cus_1", providerSubscriptionId: "sub_1",
    providerInvoiceId: "in_1", providerPaymentId: "pi_1", providerRefundId: null, providerDisputeId: null,
    amount: 1299, currency: "USD", periodStart: NOW, periodEnd: new Date("2026-09-12T12:00:00.000Z"),
  });

  it("applies a paid invoice exactly once across sequential and concurrent retries", async () => {
    await Promise.all([repository.applyEvent(invoice(), "b".repeat(64)), repository.applyEvent(invoice(), "b".repeat(64))]);
    await repository.applyEvent(invoice(), "b".repeat(64));
    expect(await database.select().from(schema.billingPayments)).toHaveLength(1);
    expect(await database.select().from(schema.billingSubscriptions)).toEqual([
      expect.objectContaining({ userId: USER_ID, status: "active", providerSubscriptionId: "sub_1" }),
    ]);
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(1);
  });

  it("rejects a new checkout reservation while the owner has a current subscription", async () => {
    await repository.applyEvent(invoice("evt_current_paid", 100), "a".repeat(64));
    const price = await repository.selectPrice({ planRef: "plus", countryCode: "US", now: NOW });
    await expect(repository.createOrGetPendingOrder({ userId: USER_ID, idempotencyKey: "active-user-checkout",
      requestHash: "b".repeat(64), price: price! })).rejects.toMatchObject({ code: "CHECKOUT_NOT_AVAILABLE" });
    expect(await database.select().from(schema.billingOrders)).toHaveLength(1);
  });

  it("serializes two different checkout reservations for one user", async () => {
    await database.update(schema.billingOrders).set({ status: "canceled" }).where(eq(schema.billingOrders.id, orderId));
    const price = await repository.selectPrice({ planRef: "plus", countryCode: "US", now: NOW });
    const results = await Promise.allSettled([
      repository.createOrGetPendingOrder({ userId: USER_ID, idempotencyKey: "concurrent-checkout-a",
        requestHash: "c".repeat(64), price: price! }),
      repository.createOrGetPendingOrder({ userId: USER_ID, idempotencyKey: "concurrent-checkout-b",
        requestHash: "d".repeat(64), price: price! }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CHECKOUT_NOT_AVAILABLE" }) }),
    ]);
    expect((await database.select().from(schema.billingOrders)).filter((order) => order.status === "pending")).toHaveLength(1);
  });

  it("acknowledges a charged second provider subscription for review without granting a second entitlement", async () => {
    await repository.applyEvent(invoice("evt_primary_paid", 100), "a".repeat(64));
    const [price] = await database.select().from(schema.billingPrices);
    const [duplicateOrder] = await database.insert(schema.billingOrders).values({ userId: USER_ID, priceId: price!.id,
      idempotencyKey: "already-created-second", requestHash: "e".repeat(64), planRef: "plus", planVersion: 1,
      amount: 1299, currency: "USD" }).returning();
    const duplicate = { ...invoice("evt_second_paid", 200), objectId: "in_second", orderId: duplicateOrder!.id,
      providerSubscriptionId: "sub_second", providerInvoiceId: "in_second", providerPaymentId: "pi_second" };
    await expect(repository.applyEvent(duplicate, "f".repeat(64)))
      .resolves.toMatchObject({ duplicate: false, outcome: "ignored" });
    expect(await database.select().from(schema.billingPayments)).toHaveLength(2);
    expect(await database.select({ providerId: schema.billingSubscriptions.providerSubscriptionId,
      status: schema.billingSubscriptions.status, override: schema.billingSubscriptions.entitlementOverride })
      .from(schema.billingSubscriptions)).toEqual(expect.arrayContaining([
      { providerId: "sub_1", status: "active", override: "none" },
      { providerId: "sub_second", status: "revoked", override: "duplicate_subscription" },
    ]));
    expect((await database.select().from(schema.billingOrders)
      .where(eq(schema.billingOrders.id, duplicateOrder!.id)))[0]!.status).toBe("review_required");
    expect((await database.select().from(schema.billingWebhookEvents)
      .where(eq(schema.billingWebhookEvents.providerEventId, duplicate.id)))[0]!.reviewReason)
      .toBe("DUPLICATE_SUBSCRIPTION_REQUIRES_COMPENSATION");
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(1);

    const compensation = { ...duplicate, id: "evt_second_refund", type: "refund.created" as const,
      objectId: "re_second", objectVersion: 210, createdAt: new Date(NOW.getTime() + 210_000),
      providerInvoiceId: null, providerRefundId: "re_second" };
    await expect(repository.applyEvent(compensation, "1".repeat(64)))
      .resolves.toMatchObject({ duplicate: false, outcome: "applied" });
    expect(await database.select().from(schema.billingRefunds)).toHaveLength(1);
    expect((await database.select().from(schema.billingOrders)
      .where(eq(schema.billingOrders.id, duplicateOrder!.id)))[0]!.status).toBe("refunded");
    expect((await database.select().from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.providerSubscriptionId, "sub_second")))[0])
      .toEqual(expect.objectContaining({ status: "revoked", entitlementOverride: "duplicate_subscription" }));
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(1);
  });

  it("writes nothing on transient enrichment failure and exactly one ledger fact after retry succeeds", async () => {
    const normalized = invoice("evt_enrichment_retry", 100);
    const verifyAndNormalize = vi.fn()
      .mockRejectedValueOnce(new ProviderEnrichmentError())
      .mockResolvedValue(normalized);
    const service = new WebhookService({ verifier: { verifyAndNormalize }, store: repository });
    await expect(service.handle(new TextEncoder().encode("signed payload"), "valid-signature"))
      .rejects.toEqual(new BillingError("PROVIDER_UNAVAILABLE"));
    expect(await database.select().from(schema.billingWebhookEvents)).toHaveLength(0);
    expect(await database.select().from(schema.billingPayments)).toHaveLength(0);
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(0);
    await expect(service.handle(new TextEncoder().encode("signed payload"), "valid-signature"))
      .resolves.toEqual({ acknowledged: true, duplicate: false });
    expect(await database.select().from(schema.billingWebhookEvents)).toHaveLength(1);
    expect(await database.select().from(schema.billingPayments)).toHaveLength(1);
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(1);
  });

  it("does not let stale events regress active state and handles grace, cancel and restore", async () => {
    await repository.applyEvent(invoice("evt_paid", 100), "b".repeat(64));
    const base = invoice("evt_stale", 90);
    const stale = await repository.applyEvent({ ...base, type: "subscription.deleted", subscriptionStatus: "canceled" }, "c".repeat(64));
    expect(stale.outcome).toBe("stale");
    const failedBase = invoice("evt_failed", 110);
    await repository.applyEvent({ ...failedBase, type: "invoice.payment_failed", providerInvoiceId: "in_2",
      providerPaymentId: null, amount: 1299 }, "d".repeat(64));
    expect(await database.select({ status: schema.billingSubscriptions.status, grace: schema.billingSubscriptions.graceEndsAt })
      .from(schema.billingSubscriptions)).toEqual([{ status: "grace_period", grace: new Date(NOW.getTime() + 3 * 86_400_000) }]);
    const cancelBase = invoice("evt_cancel", 120);
    await repository.applyEvent({ ...cancelBase, type: "subscription.deleted", providerInvoiceId: null,
      providerPaymentId: null, amount: null }, "e".repeat(64));
    expect((await database.select().from(schema.billingSubscriptions))[0]!.status).toBe("canceled");
    await repository.applyEvent({ ...invoice("evt_restore", 130), objectId: "in_3",
      providerInvoiceId: "in_3", providerPaymentId: "pi_3" }, "f".repeat(64));
    expect((await database.select().from(schema.billingSubscriptions))[0]!.status).toBe("active");
  });

  it.each(["active_then_canceled", "canceled_then_active"] as const)(
    "uses fail-closed deterministic precedence for same-second conflicts: %s",
    async (order) => {
      const paid = invoice("evt_same_paid", 200);
      const deleted = { ...invoice("evt_same_deleted", 200), type: "subscription.deleted" as const,
        providerInvoiceId: null, providerPaymentId: null, amount: null, subscriptionStatus: "canceled" as const };
      const events = order === "active_then_canceled" ? [paid, deleted] : [deleted, paid];
      for (const candidate of events) await repository.applyEvent(candidate, candidate.id === paid.id ? "a".repeat(64) : "b".repeat(64));
      expect((await database.select().from(schema.billingSubscriptions))[0]!.status).toBe("canceled");
    },
  );

  it("appends refunds and disputes, recomputes entitlement projection, and never edits ledger history", async () => {
    await repository.applyEvent(invoice(), "b".repeat(64));
    const refundBase = invoice("evt_refund", 110);
    await repository.applyEvent({ ...refundBase, type: "refund.created", objectId: "re_1", providerInvoiceId: null,
      providerRefundId: "re_1", amount: 1299 }, "c".repeat(64));
    const disputeBase = invoice("evt_dispute", 120);
    await repository.applyEvent({ ...disputeBase, type: "dispute.created", objectId: "dp_1", providerInvoiceId: null,
      providerDisputeId: "dp_1", amount: 1299 }, "d".repeat(64));
    expect(await database.select().from(schema.billingRefunds)).toHaveLength(1);
    expect(await database.select().from(schema.billingDisputes)).toEqual([expect.objectContaining({ status: "needs_review" })]);
    expect((await database.select().from(schema.billingPayments))).toHaveLength(1);
    await expect(database.update(schema.billingPayments).set({ amount: 1 })).rejects.toMatchObject({
      cause: { message: expect.stringContaining("BILLING_LEDGER_APPEND_ONLY") },
    });
    await expect(database.delete(schema.billingRefunds)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("BILLING_LEDGER_APPEND_ONLY") },
    });
    const [dispute] = await database.select().from(schema.billingDisputes);
    await expect(database.update(schema.billingDisputes).set({ status: "closed" })
      .where(eq(schema.billingDisputes.id, dispute!.id))).resolves.toBeDefined();
    await expect(database.update(schema.billingDisputes).set({ amount: 1 })
      .where(eq(schema.billingDisputes.id, dispute!.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("BILLING_DISPUTE_FACTS_IMMUTABLE") },
    });
  });

  it("applies sequential partial refunds and transitions a full refund exactly once", async () => {
    await repository.applyEvent(invoice("evt_partial_paid", 100), "a".repeat(64));
    const partial = (id: string, refundId: string, amount: number, version: number): NormalizedBillingEvent => ({
      ...invoice(id, version), type: "refund.created", objectId: refundId, providerInvoiceId: null,
      providerRefundId: refundId, amount,
    });
    await repository.applyEvent(partial("evt_partial_600", "re_partial_600", 600, 110), "b".repeat(64));
    expect((await database.select().from(schema.billingOrders))[0]!.status).toBe("paid");
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      status: "active", entitlementOverride: "none",
    }));
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(1);

    await repository.applyEvent(partial("evt_partial_699", "re_partial_699", 699, 111), "c".repeat(64));
    expect((await database.select().from(schema.billingRefunds)).map((refund) => refund.amount)).toEqual([600, 699]);
    expect((await database.select().from(schema.billingOrders))[0]!.status).toBe("refunded");
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      status: "expired", entitlementOverride: "refund_full",
    }));
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(2);
    await repository.applyEvent(partial("evt_partial_699", "re_partial_699", 699, 111), "c".repeat(64));
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(2);
  });

  it("keeps a current full refund authoritative when the earlier dispute later closes won", async () => {
    await repository.applyEvent(invoice("evt_refund_after_dispute_paid", 100), "a".repeat(64));
    const opened = { ...invoice("evt_refund_after_dispute_open", 110), type: "dispute.created" as const,
      objectId: "dp_refund_after_dispute", providerInvoiceId: null, providerDisputeId: "dp_refund_after_dispute",
      disputeStatus: "needs_review" as const };
    await repository.applyEvent(opened, "b".repeat(64));
    const refunded = { ...opened, id: "evt_refund_after_dispute_full", type: "refund.created" as const,
      objectId: "re_refund_after_dispute", objectVersion: 120, createdAt: new Date(NOW.getTime() + 120_000),
      providerDisputeId: null, providerRefundId: "re_refund_after_dispute", amount: 1299 };
    await expect(repository.applyEvent(refunded, "c".repeat(64)))
      .resolves.toMatchObject({ duplicate: false, outcome: "applied" });
    expect(await database.select().from(schema.billingRefunds)).toHaveLength(1);
    expect((await database.select().from(schema.billingOrders))[0]!.status).toBe("refunded");
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      providerStatus: "active", status: "expired", entitlementOverride: "refund_full",
    }));
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(3);
    const won = { ...opened, id: "evt_refund_after_dispute_won", type: "dispute.closed" as const,
      objectVersion: 130, createdAt: new Date(NOW.getTime() + 130_000), disputeStatus: "won" as const };
    await expect(repository.applyEvent(won, "d".repeat(64)))
      .resolves.toMatchObject({ duplicate: false, outcome: "applied" });
    expect((await database.select().from(schema.billingOrders))[0]!.status).toBe("refunded");
    expect(await database.select().from(schema.billingRefunds)).toHaveLength(1);
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      providerStatus: "active", status: "expired", entitlementOverride: "refund_full",
    }));
    expect((await database.select().from(schema.billingDisputes))[0]!.status).toBe("won");
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(3);
  });

  it("keeps duplicate-subscription compensation review visible through dispute created and won", async () => {
    await repository.applyEvent(invoice("evt_duplicate_dispute_primary", 100), "a".repeat(64));
    const [price] = await database.select().from(schema.billingPrices);
    const [duplicateOrder] = await database.insert(schema.billingOrders).values({ userId: USER_ID, priceId: price!.id,
      idempotencyKey: "duplicate-dispute-order", requestHash: "b".repeat(64), planRef: "plus", planVersion: 1,
      amount: 1299, currency: "USD" }).returning();
    const duplicatePaid = { ...invoice("evt_duplicate_dispute_paid", 200), objectId: "in_duplicate_dispute",
      orderId: duplicateOrder!.id, providerSubscriptionId: "sub_duplicate_dispute",
      providerInvoiceId: "in_duplicate_dispute", providerPaymentId: "pi_duplicate_dispute" };
    await repository.applyEvent(duplicatePaid, "c".repeat(64));
    const disputed = { ...duplicatePaid, id: "evt_duplicate_dispute_open", type: "dispute.created" as const,
      objectId: "dp_duplicate_dispute", objectVersion: 210, createdAt: new Date(NOW.getTime() + 210_000),
      providerInvoiceId: null, providerDisputeId: "dp_duplicate_dispute", disputeStatus: "needs_review" as const };
    await expect(repository.applyEvent(disputed, "d".repeat(64)))
      .resolves.toMatchObject({ duplicate: false, outcome: "applied" });
    expect(await database.select().from(schema.billingDisputes)).toEqual([
      expect.objectContaining({ providerDisputeId: "dp_duplicate_dispute", status: "needs_review" }),
    ]);
    expect((await database.select().from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.providerSubscriptionId, "sub_duplicate_dispute")))[0])
      .toEqual(expect.objectContaining({ status: "revoked", entitlementOverride: "duplicate_subscription" }));
    expect((await database.select().from(schema.billingOrders)
      .where(eq(schema.billingOrders.id, duplicateOrder!.id)))[0]!.status).toBe("review_required");
    expect((await database.select().from(schema.billingWebhookEvents)
      .where(eq(schema.billingWebhookEvents.providerEventId, disputed.id)))[0]!.reviewReason)
      .toBe("DUPLICATE_SUBSCRIPTION_REQUIRES_COMPENSATION");
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(1);
    const won = { ...disputed, id: "evt_duplicate_dispute_won", type: "dispute.closed" as const,
      objectVersion: 220, createdAt: new Date(NOW.getTime() + 220_000), disputeStatus: "won" as const };
    await expect(repository.applyEvent(won, "e".repeat(64)))
      .resolves.toMatchObject({ duplicate: false, outcome: "applied" });
    expect((await database.select().from(schema.billingOrders)
      .where(eq(schema.billingOrders.id, duplicateOrder!.id)))[0]!.status).toBe("review_required");
    expect((await database.select().from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.providerSubscriptionId, "sub_duplicate_dispute")))[0])
      .toEqual(expect.objectContaining({ status: "revoked", entitlementOverride: "duplicate_subscription" }));
    expect((await database.select().from(schema.billingDisputes))[0]!.status).toBe("won");
    expect((await database.select().from(schema.billingWebhookEvents)
      .where(eq(schema.billingWebhookEvents.providerEventId, won.id)))[0]!.reviewReason)
      .toBe("DUPLICATE_SUBSCRIPTION_REQUIRES_COMPENSATION");
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(1);
  });

  it("persists every invoice payment relation and resolves a later relation for refunds and disputes", async () => {
    const paid = { ...invoice("evt_multi_paid", 100), providerInvoicePaymentId: "inpay_primary",
      providerPaymentId: "pi_primary", providerChargeId: "ch_primary", paymentLinks: [
        { providerInvoicePaymentId: "inpay_primary", providerPaymentId: "pi_primary", providerChargeId: "ch_primary" },
        { providerInvoicePaymentId: "inpay_secondary", providerPaymentId: "pi_secondary", providerChargeId: "ch_secondary" },
      ] };
    await repository.applyEvent(paid, "2".repeat(64));
    const refund = { ...paid, id: "evt_multi_refund", type: "refund.created" as const, objectId: "re_multi",
      objectVersion: 110, createdAt: new Date(NOW.getTime() + 110_000), providerInvoiceId: null,
      providerInvoicePaymentId: null, paymentLinks: undefined, providerPaymentId: "pi_secondary",
      providerChargeId: null, providerRefundId: "re_multi", amount: 100 };
    await expect(repository.applyEvent(refund, "3".repeat(64))).resolves.toMatchObject({ outcome: "applied" });
    const dispute = { ...refund, id: "evt_multi_dispute", type: "dispute.created" as const, objectId: "dp_multi",
      objectVersion: 120, createdAt: new Date(NOW.getTime() + 120_000), providerPaymentId: null,
      providerChargeId: "ch_secondary", providerRefundId: null, providerDisputeId: "dp_multi", amount: 1299,
      disputeStatus: "needs_review" as const };
    await expect(repository.applyEvent(dispute, "4".repeat(64))).resolves.toMatchObject({ outcome: "applied" });
    expect(await database.select().from(schema.billingPayments)).toHaveLength(1);
    expect(await database.select().from(schema.billingInvoicePaymentLinks)).toHaveLength(2);
    expect(await database.select().from(schema.billingRefunds)).toHaveLength(1);
    expect(await database.select().from(schema.billingDisputes)).toHaveLength(1);
  });

  it.each(["refund", "dispute"] as const)(
    "reviews an ambiguous shared payment-intent %s without mutating either ledger owner",
    async (kind) => {
      const first = { ...invoice("evt_shared_pi_first", 100), objectId: "in_shared_pi_first",
        providerInvoiceId: "in_shared_pi_first", providerInvoicePaymentId: "inpay_shared_pi_first",
        providerPaymentId: "pi_shared", providerChargeId: "ch_shared_first", paymentLinks: [
          { providerInvoicePaymentId: "inpay_shared_pi_first", providerPaymentId: "pi_shared",
            providerChargeId: "ch_shared_first" },
        ] };
      const second = { ...invoice("evt_shared_pi_second", 200), objectId: "in_shared_pi_second",
        providerInvoiceId: "in_shared_pi_second", providerInvoicePaymentId: "inpay_shared_pi_second",
        providerPaymentId: "pi_shared", providerChargeId: "ch_shared_second", paymentLinks: [
          { providerInvoicePaymentId: "inpay_shared_pi_second", providerPaymentId: "pi_shared",
            providerChargeId: "ch_shared_second" },
        ] };
      await repository.applyEvent(first, "1".repeat(64));
      await repository.applyEvent(second, "2".repeat(64));
      const beforeOrders = await database.select().from(schema.billingOrders);
      const beforeSubscriptions = await database.select().from(schema.billingSubscriptions);
      const beforeOutbox = await database.select().from(schema.billingEntitlementOutbox);
      const ambiguous = { ...second, id: `evt_shared_pi_${kind}`, type: kind === "refund"
        ? "refund.created" as const : "dispute.created" as const, objectId: kind === "refund"
          ? "re_shared_pi" : "dp_shared_pi", objectVersion: 210, createdAt: new Date(NOW.getTime() + 210_000),
        providerInvoiceId: null, providerInvoicePaymentId: null, paymentLinks: undefined,
        providerChargeId: null, providerRefundId: kind === "refund" ? "re_shared_pi" : null,
        providerDisputeId: kind === "dispute" ? "dp_shared_pi" : null,
        disputeStatus: kind === "dispute" ? "needs_review" as const : undefined };
      await expect(repository.applyEvent(ambiguous, "3".repeat(64)))
        .resolves.toMatchObject({ duplicate: false, outcome: "ignored" });
      expect(await database.select().from(schema.billingRefunds)).toHaveLength(0);
      expect(await database.select().from(schema.billingDisputes)).toHaveLength(0);
      expect(await database.select().from(schema.billingOrders)).toEqual(beforeOrders);
      expect(await database.select().from(schema.billingSubscriptions)).toEqual(beforeSubscriptions);
      expect(await database.select().from(schema.billingEntitlementOutbox)).toEqual(beforeOutbox);
      expect((await database.select().from(schema.billingWebhookEvents)
        .where(eq(schema.billingWebhookEvents.providerEventId, ambiguous.id)))[0])
        .toEqual(expect.objectContaining({ outcome: "ignored", reviewReason: "AMBIGUOUS_PAYMENT_REFERENCE" }));
    },
  );

  it("uses a unique charge to disambiguate two invoices that share one payment intent", async () => {
    const first = { ...invoice("evt_shared_charge_first", 100), objectId: "in_shared_charge_first",
      providerInvoiceId: "in_shared_charge_first", providerInvoicePaymentId: "inpay_shared_charge_first",
      providerPaymentId: "pi_shared_charge", providerChargeId: "ch_unique_first", paymentLinks: [
        { providerInvoicePaymentId: "inpay_shared_charge_first", providerPaymentId: "pi_shared_charge",
          providerChargeId: "ch_unique_first" },
      ] };
    const second = { ...invoice("evt_shared_charge_second", 200), objectId: "in_shared_charge_second",
      providerInvoiceId: "in_shared_charge_second", providerInvoicePaymentId: "inpay_shared_charge_second",
      providerPaymentId: "pi_shared_charge", providerChargeId: "ch_unique_second", paymentLinks: [
        { providerInvoicePaymentId: "inpay_shared_charge_second", providerPaymentId: "pi_shared_charge",
          providerChargeId: "ch_unique_second" },
      ] };
    await repository.applyEvent(first, "4".repeat(64));
    await repository.applyEvent(second, "5".repeat(64));
    const refund = { ...second, id: "evt_shared_charge_refund", type: "refund.created" as const,
      objectId: "re_shared_charge", objectVersion: 210, createdAt: new Date(NOW.getTime() + 210_000),
      providerInvoiceId: null, providerInvoicePaymentId: null, paymentLinks: undefined,
      providerRefundId: "re_shared_charge", providerChargeId: "ch_unique_second", amount: 100 };
    await expect(repository.applyEvent(refund, "6".repeat(64)))
      .resolves.toMatchObject({ outcome: "applied" });
    const [secondPayment] = await database.select().from(schema.billingPayments)
      .where(eq(schema.billingPayments.providerInvoiceId, "in_shared_charge_second"));
    expect(await database.select().from(schema.billingRefunds)).toEqual([
      expect.objectContaining({ paymentId: secondPayment!.id, providerRefundId: "re_shared_charge" }),
    ]);
  });

  it("uses an exact invoice-payment reference before a shared payment intent", async () => {
    const first = { ...invoice("evt_exact_inpay_first", 100), objectId: "in_exact_inpay_first",
      providerInvoiceId: "in_exact_inpay_first", providerInvoicePaymentId: "inpay_exact_first",
      providerPaymentId: "pi_exact_shared", providerChargeId: null, paymentLinks: [
        { providerInvoicePaymentId: "inpay_exact_first", providerPaymentId: "pi_exact_shared", providerChargeId: null },
      ] };
    const second = { ...invoice("evt_exact_inpay_second", 200), objectId: "in_exact_inpay_second",
      providerInvoiceId: "in_exact_inpay_second", providerInvoicePaymentId: "inpay_exact_second",
      providerPaymentId: "pi_exact_shared", providerChargeId: null, paymentLinks: [
        { providerInvoicePaymentId: "inpay_exact_second", providerPaymentId: "pi_exact_shared", providerChargeId: null },
      ] };
    await repository.applyEvent(first, "7".repeat(64));
    await repository.applyEvent(second, "8".repeat(64));
    const refund = { ...second, id: "evt_exact_inpay_refund", type: "refund.created" as const,
      objectId: "re_exact_inpay", objectVersion: 210, createdAt: new Date(NOW.getTime() + 210_000),
      providerInvoiceId: null, paymentLinks: undefined, providerInvoicePaymentId: "inpay_exact_second",
      providerPaymentId: null, providerRefundId: "re_exact_inpay", amount: 100 };
    await expect(repository.applyEvent(refund, "9".repeat(64)))
      .resolves.toMatchObject({ outcome: "applied" });
    const [secondPayment] = await database.select().from(schema.billingPayments)
      .where(eq(schema.billingPayments.providerInvoiceId, "in_exact_inpay_second"));
    expect(await database.select().from(schema.billingRefunds)).toEqual([
      expect.objectContaining({ paymentId: secondPayment!.id, providerRefundId: "re_exact_inpay" }),
    ]);
  });

  it("records a historic full refund without revoking the newer paid entitlement source", async () => {
    const oldPaid = { ...invoice("evt_old_period_paid", 100), objectId: "in_old_period",
      providerInvoiceId: "in_old_period", providerPaymentId: "pi_old_period",
      periodStart: NOW, periodEnd: new Date("2026-09-12T12:00:00.000Z") };
    const newPaid = { ...invoice("evt_new_period_paid", 200), objectId: "in_new_period",
      providerInvoiceId: "in_new_period", providerPaymentId: "pi_new_period",
      periodStart: new Date("2026-09-12T12:00:00.000Z"), periodEnd: new Date("2026-10-12T12:00:00.000Z") };
    await repository.applyEvent(oldPaid, "5".repeat(64));
    await repository.applyEvent(newPaid, "6".repeat(64));
    const payments = await database.select().from(schema.billingPayments);
    const newPayment = payments.find((payment) => payment.providerInvoiceId === "in_new_period")!;
    expect((await database.select().from(schema.billingSubscriptions))[0])
      .toEqual(expect.objectContaining({ status: "active", currentEntitlementPaymentId: newPayment.id }));

    const historicRefund = { ...oldPaid, id: "evt_old_period_refund", type: "refund.created" as const,
      objectId: "re_old_period", objectVersion: 300, createdAt: new Date(NOW.getTime() + 300_000),
      providerInvoiceId: null, providerRefundId: "re_old_period", amount: 1299 };
    await repository.applyEvent(historicRefund, "7".repeat(64));
    expect(await database.select().from(schema.billingRefunds)).toHaveLength(1);
    expect((await database.select().from(schema.billingOrders))[0]!.status).toBe("refunded");
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      status: "active", entitlementOverride: "none", currentEntitlementPaymentId: newPayment.id,
    }));
    expect(await database.select().from(schema.billingEntitlementOutbox)).toHaveLength(2);
  });

  it("commits an older refund fact without regressing a newer subscription projection", async () => {
    await repository.applyEvent(invoice("evt_newer_paid", 200), "a".repeat(64));
    const olderRefund = { ...invoice("evt_older_refund", 150), type: "refund.created" as const,
      objectId: "re_older", providerInvoiceId: null, providerRefundId: "re_older", amount: 1299 };
    await expect(repository.applyEvent(olderRefund, "b".repeat(64))).resolves.toMatchObject({ outcome: "applied" });
    expect(await database.select().from(schema.billingRefunds)).toHaveLength(1);
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(
      expect.objectContaining({ status: "active", providerObjectVersion: 200 }),
    );
  });

  it.each(["won", "lost"] as const)(
    "revokes paid entitlement for an open dispute and applies terminal outcome %s without touching free defaults",
    async (terminalStatus) => {
      await repository.applyEvent(invoice("evt_dispute_paid", 100), "a".repeat(64));
      const worker = new BillingEntitlementRefreshWorker({
        store: new DrizzleEntitlementRefreshStore(database, { clock: () => NOW }), invalidate: async () => undefined,
      });
      await worker.drain(10);
      expect((await database.select().from(schema.entitlementUserPlanAssignments))[0]!.active).toBe(true);

      const opened = { ...invoice("evt_dispute_opened", 110), type: "dispute.created" as const,
        objectId: "dp_lifecycle", providerInvoiceId: null, providerDisputeId: "dp_lifecycle",
        disputeStatus: "needs_review" as const };
      await repository.applyEvent(opened, "b".repeat(64));
      await worker.drain(10);
      expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
        status: "disputed", providerStatus: "active", entitlementOverride: "dispute_open",
      }));
      expect((await database.select().from(schema.entitlementUserPlanAssignments))[0]!.active).toBe(false);

      const closed = { ...opened, id: `evt_dispute_${terminalStatus}`, type: "dispute.closed" as const,
        objectVersion: 120, createdAt: new Date(NOW.getTime() + 120_000), disputeStatus: terminalStatus };
      await repository.applyEvent(closed, "c".repeat(64));
      await worker.drain(10);
      expect((await database.select().from(schema.billingSubscriptions))[0]!.status)
        .toBe(terminalStatus === "won" ? "active" : "revoked");
      expect((await database.select().from(schema.billingSubscriptions))[0]!.entitlementOverride)
        .toBe(terminalStatus === "won" ? "none" : "dispute_lost");
      expect((await database.select().from(schema.entitlementUserPlanAssignments)).some((row) => row.active))
        .toBe(terminalStatus === "won");
      expect((await database.select().from(schema.billingDisputes))[0]!.status).toBe(terminalStatus);
      const freeDefaults = await database.select().from(schema.entitlementConfigurations)
        .where(eq(schema.entitlementConfigurations.scope, "free_default"));
      expect(freeDefaults.length).toBeGreaterThan(0);
      expect(freeDefaults.every((row) => row.active)).toBe(true);
    },
  );

  it("persists provider facts beneath a dispute override and restores the latest provider state on win", async () => {
    await repository.applyEvent(invoice("evt_layer_paid", 100), "a".repeat(64));
    const opened = { ...invoice("evt_layer_open", 110), type: "dispute.created" as const,
      objectId: "dp_layer", providerInvoiceId: null, providerDisputeId: "dp_layer",
      disputeStatus: "needs_review" as const };
    await repository.applyEvent(opened, "b".repeat(64));
    const providerActive = { ...invoice("evt_layer_active", 120), type: "subscription.updated" as const,
      objectId: "sub_1", providerInvoiceId: null, providerPaymentId: null, amount: null,
      subscriptionStatus: "active" as const, cancelAtPeriodEnd: true };
    await expect(repository.applyEvent(providerActive, "c".repeat(64))).resolves.toMatchObject({ outcome: "applied" });
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      providerStatus: "active", entitlementOverride: "dispute_open", status: "disputed", cancelAtPeriodEnd: true,
    }));
    const failed = { ...providerActive, id: "evt_layer_failed", type: "invoice.payment_failed" as const,
      objectVersion: 130, createdAt: new Date(NOW.getTime() + 130_000), providerInvoiceId: "in_failed" };
    await expect(repository.applyEvent(failed, "d".repeat(64))).resolves.toMatchObject({ outcome: "applied" });
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      providerStatus: "grace_period", entitlementOverride: "dispute_open", status: "disputed",
    }));
    const canceled = { ...providerActive, id: "evt_layer_canceled", type: "subscription.deleted" as const,
      objectVersion: 140, createdAt: new Date(NOW.getTime() + 140_000), subscriptionStatus: "canceled" as const };
    await expect(repository.applyEvent(canceled, "e".repeat(64))).resolves.toMatchObject({ outcome: "applied" });
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      providerStatus: "canceled", entitlementOverride: "dispute_open", status: "disputed",
    }));
    await repository.applyEvent({ ...opened, id: "evt_layer_won", type: "dispute.closed", disputeStatus: "won",
      objectVersion: 150, createdAt: new Date(NOW.getTime() + 150_000) }, "f".repeat(64));
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      providerStatus: "canceled", entitlementOverride: "none", status: "canceled",
    }));
  });

  it("makes a lost dispute explicitly non-entitled without blocking a legitimate replacement subscription", async () => {
    await repository.applyEvent(invoice("evt_lost_paid", 100), "a".repeat(64));
    const opened = { ...invoice("evt_lost_open", 110), type: "dispute.created" as const,
      objectId: "dp_lost", providerInvoiceId: null, providerDisputeId: "dp_lost", disputeStatus: "needs_review" as const };
    await repository.applyEvent(opened, "b".repeat(64));
    await repository.applyEvent({ ...opened, id: "evt_lost_closed", type: "dispute.closed", disputeStatus: "lost",
      objectVersion: 120, createdAt: new Date(NOW.getTime() + 120_000) }, "c".repeat(64));
    expect((await database.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      status: "revoked", providerStatus: "active", entitlementOverride: "dispute_lost",
    }));

    const price = await repository.selectPrice({ planRef: "plus", countryCode: "US", currency: "USD", now: NOW });
    const replacement = await repository.createOrGetPendingOrder({ userId: USER_ID, idempotencyKey: "replacement-order",
      requestHash: "d".repeat(64), price: price! });
    await repository.applyEvent({ ...invoice("evt_replacement", 200), objectId: "in_replacement",
      orderId: replacement.order.id, providerSubscriptionId: "sub_replacement", providerInvoiceId: "in_replacement",
      providerPaymentId: "pi_replacement" }, "e".repeat(64));
    expect(await database.select({ providerId: schema.billingSubscriptions.providerSubscriptionId,
      status: schema.billingSubscriptions.status }).from(schema.billingSubscriptions))
      .toEqual(expect.arrayContaining([{ providerId: "sub_1", status: "revoked" },
        { providerId: "sub_replacement", status: "active" }]));
  });

  it("records unknown events safely and rolls back event/outbox when application fails", async () => {
    const unknown = { ...invoice("evt_unknown"), type: "unknown" as const, reviewReason: "UNKNOWN_TEST_STATUS" };
    await expect(repository.applyEvent(unknown, "e".repeat(64))).resolves.toMatchObject({ outcome: "ignored" });
    expect(await database.select({ reviewReason: schema.billingWebhookEvents.reviewReason })
      .from(schema.billingWebhookEvents).where(eq(schema.billingWebhookEvents.providerEventId, unknown.id)))
      .toEqual([{ reviewReason: "UNKNOWN_TEST_STATUS" }]);
    expect(await database.select().from(schema.billingPayments)).toHaveLength(0);
    await expect(repository.applyEvent({ ...invoice("evt_bad"), amount: 5, currency: "EUR" }, "f".repeat(64))).rejects.toThrow();
    expect(await database.select().from(schema.billingWebhookEvents).where(eq(schema.billingWebhookEvents.providerEventId, "evt_bad"))).toEqual([]);
    expect(await database.select().from(schema.billingEntitlementOutbox)).toEqual([]);
  });

  it("fails an unknown provider subscription status closed while preserving its review audit", async () => {
    await repository.applyEvent(invoice("evt_unknown_paid", 100), "a".repeat(64));
    const futureStatus = { ...invoice("evt_unknown_status", 110), type: "unknown" as const,
      objectId: "sub_1", providerInvoiceId: null, providerPaymentId: null, amount: null,
      subscriptionStatus: "expired" as const, reviewReason: "UNKNOWN_SUBSCRIPTION_STATUS:future_activeish" };
    await expect(repository.applyEvent(futureStatus, "b".repeat(64))).resolves.toMatchObject({ outcome: "applied" });
    expect((await database.select().from(schema.billingSubscriptions))[0]!.status).toBe("expired");
    expect((await database.select().from(schema.billingWebhookEvents)
      .where(eq(schema.billingWebhookEvents.providerEventId, futureStatus.id)))[0]!.reviewReason)
      .toBe("UNKNOWN_SUBSCRIPTION_STATUS:future_activeish");
  });

  it("enforces provider customer ownership, one current subscription, amount/currency and transitions", async () => {
    await repository.applyEvent(invoice(), "b".repeat(64));
    await expect(database.insert(schema.billingSubscriptions).values({ userId: USER_ID,
      priceId: (await database.select().from(schema.billingPrices))[0]!.id, planRef: "plus",
      providerCustomerId: "cus_other", providerSubscriptionId: "sub_other", status: "active",
      providerObjectVersion: 1, providerEventCreatedAt: NOW })).rejects.toThrow();
    await expect(database.execute(sql`UPDATE billing_subscriptions SET status = 'trialing', provider_object_version = 200 WHERE provider_subscription_id = 'sub_1'`))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining("BILLING_SUBSCRIPTION_EFFECTIVE_STATUS_INVALID") } });
    await expect(database.insert(schema.billingRefunds).values({ paymentId: (await database.select().from(schema.billingPayments))[0]!.id,
      providerRefundId: "re_bad", providerEventId: "evt_paid", amount: -1, currency: "usd" })).rejects.toThrow();
  });

  it("projects paid membership only from committed outbox and deactivates it after cancellation", async () => {
    await repository.applyEvent(invoice(), "b".repeat(64));
    const invalidationSawCommit: boolean[] = [];
    const worker = new BillingEntitlementRefreshWorker({ store: new DrizzleEntitlementRefreshStore(database, { clock: () => NOW }),
      invalidate: async () => { invalidationSawCommit.push((await database.select().from(schema.entitlementUserPlanAssignments)).length === 1); } });
    expect(await worker.drain(10)).toEqual({ processed: 1, failed: 0 });
    expect(invalidationSawCommit).toEqual([true]);
    expect(await database.select().from(schema.entitlementUserPlanAssignments)).toEqual([
      expect.objectContaining({ userId: USER_ID, planRef: "plus", active: true }),
    ]);
    const cancelBase = invoice("evt_cancel_projection", 120);
    await repository.applyEvent({ ...cancelBase, type: "subscription.deleted", providerInvoiceId: null,
      providerPaymentId: null, amount: null }, "c".repeat(64));
    expect(await worker.drain(10)).toEqual({ processed: 1, failed: 0 });
    expect((await database.select().from(schema.entitlementUserPlanAssignments))[0]!.active).toBe(false);
    const freeDefaults = await database.select().from(schema.entitlementConfigurations)
      .where(eq(schema.entitlementConfigurations.scope, "free_default"));
    expect(freeDefaults.length).toBeGreaterThan(0);
    expect(freeDefaults.filter((row) => row.entitlementKey === "message.send.daily" || row.entitlementKey === "search.advanced.use")
      .every((row) => row.active && row.enabled)).toBe(true);
  });

  it("persists idempotent reconciliation discrepancies without silently editing the ledger", async () => {
    await repository.applyEvent(invoice(), "b".repeat(64));
    const before = await database.select().from(schema.billingPayments);
    const store = new DrizzleReconciliationStore(database, { clock: () => NOW });
    const provider = { listLedgerPage: async () => ({ subscriptions: [], invoices: [], refunds: [],
      disputes: [{ id: "dp_provider", status: "needs_response", amount: 1299 }], nextCursor: null }) };
    const service = new ReconciliationService({ store, provider, batchSize: 25 });
    const [first, competing] = await Promise.allSettled([
      service.run("daily:2026-08-12"), service.run("daily:2026-08-12"),
    ]);
    expect([first.status, competing.status].sort()).toEqual(["fulfilled", "rejected"]);
    const replay = await service.run("daily:2026-08-12");
    expect(replay.discrepancies).toBeGreaterThan(0);
    const items = await database.select().from(schema.billingReconciliationItems);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.internalFingerprint === null || /^[a-f0-9]{64}$/u.test(item.internalFingerprint))).toBe(true);
    expect(await database.select().from(schema.billingPayments)).toEqual(before);
  });

  it("paginates the complete internal ledger beyond one hundred rows without duplicates", async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      providerEventId: `evt_page_${String(index).padStart(3, "0")}`, eventType: "invoice.paid",
      payloadHash: String(index % 10).repeat(64), objectId: `in_page_${String(index).padStart(3, "0")}`,
      providerCreatedAt: NOW, outcome: "applied", processedAt: NOW,
    }));
    await database.insert(schema.billingWebhookEvents).values(events);
    await database.insert(schema.billingPayments).values(events.map((event, index) => ({
      providerInvoiceId: event.objectId, providerEventId: event.providerEventId,
      amount: index, currency: "USD", paidAt: NOW, createdAt: NOW,
    })));
    const store = new DrizzleReconciliationStore(database, { clock: () => NOW });
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await store.snapshotPage({ cursor, limit: 40 });
      ids.push(...page.invoices.map((row) => row.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(ids).toHaveLength(101);
    expect(new Set(ids).size).toBe(101);
  });

  it("persists reconciliation collection progress between worker ticks", async () => {
    const cursors: Array<string | null> = [];
    const provider = { listLedgerPage: vi.fn(async ({ cursor }: { cursor: string | null }) => {
      cursors.push(cursor);
      const index = cursor ? Number(cursor.slice(1)) : 0;
      return { subscriptions: [{ id: `provider_sub_${index}`, status: "active" }], invoices: [], refunds: [], disputes: [],
        nextCursor: index < 51 ? `p${index + 1}` : null };
    }) };
    const store = new DrizzleReconciliationStore(database, { clock: () => NOW });
    const service = new ReconciliationService({ store, provider, batchSize: 25, pagesPerRun: 50 });
    const first = await service.run("resume:pglite");
    expect(first.nextCursor).toBe("p50");
    expect((await database.select().from(schema.billingReconciliationRuns))[0]).toEqual(expect.objectContaining({
      status: "retry", phase: "provider", cursor: "p50", attempts: 0,
    }));
    expect(await database.select().from(schema.billingReconciliationCollected)).toHaveLength(50);
    const second = await service.run("resume:pglite");
    expect(second).toMatchObject({ discrepancies: 52, nextCursor: null });
    expect(cursors.filter((value) => value === null)).toHaveLength(1);
    expect((await database.select().from(schema.billingReconciliationRuns))[0]!.status).toBe("completed");
  });

  it("persists reconciliation cursor history and backs off when a later tick repeats a cursor", async () => {
    const provider = { listLedgerPage: vi.fn(async ({ cursor }: { cursor: string | null }) => ({
      subscriptions: [], invoices: [], refunds: [], disputes: [],
      nextCursor: cursor === null ? "p1" : cursor === "p1" ? "p2" : "p1",
    })) };
    const store = new DrizzleReconciliationStore(database, { clock: () => NOW });
    const service = new ReconciliationService({ store, provider, batchSize: 25, pagesPerRun: 1 });
    await service.run("cycle:pglite");
    await service.run("cycle:pglite");
    await expect(service.run("cycle:pglite")).rejects.toThrow("RECONCILIATION_RETRY_LATER");
    expect(await database.select().from(schema.billingReconciliationCursors)).toHaveLength(2);
    expect((await database.select().from(schema.billingReconciliationRuns))[0]).toEqual(expect.objectContaining({
      status: "retry", attempts: 1, errorCode: "RECONCILIATION_CURSOR_CYCLE", providerPages: 2,
    }));
  });

  it("streams staged reconciliation comparison through bounded database pages", async () => {
    const [run] = await database.insert(schema.billingReconciliationRuns).values({ runKey: "compare:pglite",
      leaseExpiresAt: NOW, phase: "compare", status: "running" }).returning();
    const values = Array.from({ length: 250 }, (_, index) => ({
      runId: run!.id, objectType: "invoices", providerObjectId: `in_${String(index).padStart(4, "0")}`,
      objectStatus: "paid", amount: index,
    }));
    await database.insert(schema.billingReconciliationCollected).values(values.flatMap((value) => [
      { ...value, side: "provider" }, { ...value, side: "internal" },
    ]));
    const store = new DrizzleReconciliationStore(database, { clock: () => NOW });
    let cursor: string | null = null;
    const pageSizes: number[] = [];
    do {
      const page = await store.comparisonPage(run!.id, { cursor, limit: 40 });
      pageSizes.push(page.rows.length);
      expect(page.rows.every((row) => row.provider !== null && row.internal !== null)).toBe(true);
      cursor = page.nextCursor;
    } while (cursor);
    expect(pageSizes).toEqual([40, 40, 40, 40, 40, 40, 10]);
  });

  it("lists one deterministic offer per plan and checkout selects that exact price", async () => {
    const [newPlan] = await database.insert(schema.billingPlans).values({ planRef: "plus", version: 2,
      nameKey: "plans.plus.v2.name", descriptionKey: "plans.plus.v2.description",
      effectiveAt: new Date("2026-06-01") }).returning();
    await database.insert(schema.billingPrices).values([
      { planId: newPlan.id, version: 1, countryCode: "US", currency: "USD", unitAmount: 1499,
        interval: "monthly", intervalCount: 1, taxMode: "exclusive", providerPriceId: "price_plus_v2_1",
        effectiveAt: new Date("2026-06-01") },
      { planId: newPlan.id, version: 2, countryCode: "US", currency: "USD", unitAmount: 1599,
        interval: "monthly", intervalCount: 1, taxMode: "exclusive", providerPriceId: "price_plus_v2_2",
        effectiveAt: new Date("2026-07-01") },
    ]);
    const listed = await repository.listPrices({ countryCode: "US", currency: "USD", now: NOW, limit: 10 });
    const selected = await repository.selectPrice({ planRef: "plus", countryCode: "US", currency: "USD", now: NOW });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(expect.objectContaining({ id: selected!.id, planVersion: 2,
      providerPriceId: "price_plus_v2_2", unitAmount: 1599 }));
  });

  it("persists bounded subscription intents while webhooks remain authoritative for cancellation state", async () => {
    await repository.applyEvent(invoice("evt_manage_paid", 100), "a".repeat(64));
    const subscription = await repository.getOwnedSubscription(USER_ID);
    const created = await repository.createOrGetIntent({ userId: USER_ID, subscriptionId: subscription!.id,
      action: "cancel_at_period_end", idempotencyKey: "manage-persist-1", requestHash: "b".repeat(64) });
    expect(created.created).toBe(true);
    expect(await repository.beginIntentAttempt(created.intent.id)).toBe(true);
    await repository.markIntentSubmitted(created.intent.id);
    const replay = await repository.createOrGetIntent({ userId: USER_ID, subscriptionId: subscription!.id,
      action: "cancel_at_period_end", idempotencyKey: "manage-persist-1", requestHash: "b".repeat(64) });
    expect(replay).toMatchObject({ created: false, intent: { status: "provider_submitted" } });
    expect((await repository.getOwnedSubscription(USER_ID))!.cancelAtPeriodEnd).toBe(false);
    await expect(repository.createOrGetIntent({ userId: USER_ID, subscriptionId: subscription!.id,
      action: "resume", idempotencyKey: "manage-persist-1", requestHash: "c".repeat(64) }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const cancelWebhook = { ...invoice("evt_manage_cancel", 110), type: "subscription.updated" as const,
      objectId: "sub_1", providerInvoiceId: null, providerPaymentId: null, amount: null,
      subscriptionStatus: "active" as const, cancelAtPeriodEnd: true };
    await repository.applyEvent(cancelWebhook, "d".repeat(64));
    expect((await repository.getOwnedSubscription(USER_ID))!.cancelAtPeriodEnd).toBe(true);
    await repository.applyEvent({ ...cancelWebhook, id: "evt_manage_resume", objectVersion: 120,
      createdAt: new Date(NOW.getTime() + 120_000), cancelAtPeriodEnd: false }, "e".repeat(64));
    expect((await repository.getOwnedSubscription(USER_ID))!.cancelAtPeriodEnd).toBe(false);
  });
});
