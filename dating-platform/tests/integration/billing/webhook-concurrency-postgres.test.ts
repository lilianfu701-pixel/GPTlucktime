// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleBillingRepository } from "@/modules/billing/billing-repository";
import type { BillingPrice } from "@/modules/billing/checkout-service";
import type { NormalizedBillingEvent } from "@/modules/billing/webhook-service";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

runWithPostgres("billing PostgreSQL concurrency with independent pools", () => {
  const schemaName = `billing_test_${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-08-12T12:00:00Z");
  let admin: Pool; let leftPool: Pool; let rightPool: Pool;
  let leftDb: ReturnType<typeof drizzle<typeof schema>>; let rightDb: ReturnType<typeof drizzle<typeof schema>>;
  let left: DrizzleBillingRepository; let right: DrizzleBillingRepository;
  let event: NormalizedBillingEvent;

  const migrateSchema = async (client: PoolClient) => {
    await client.query("begin");
    try {
      await client.query(`set local search_path to "${schemaName}"`);
      const names = (await readdir(new URL("../../../drizzle", import.meta.url)))
        .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
      for (const name of names) {
        const source = (await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8"))
          .replaceAll('"public".', `"${schemaName}".`);
        for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
          await client.query(statement);
        }
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await admin.query(`create schema "${schemaName}"`);
    const client = await admin.connect();
    try { await migrateSchema(client); } finally { client.release(); }
    const options = { connectionString: TEST_DATABASE_URL, options: `-c search_path=${schemaName}`, max: 2 };
    leftPool = new Pool(options); rightPool = new Pool(options);
    leftDb = drizzle(leftPool, { schema }); rightDb = drizzle(rightPool, { schema });
    left = new DrizzleBillingRepository(leftDb, { clock: () => now });
    right = new DrizzleBillingRepository(rightDb, { clock: () => now });
    const [user] = await leftDb.insert(schema.users).values({ name: "PG Billing", email: `${schemaName}@example.test` }).returning();
    const [plan] = await leftDb.insert(schema.billingPlans).values({ planRef: "plus", version: 1,
      nameKey: "plans.plus.name", descriptionKey: "plans.plus.description", effectiveAt: now }).returning();
    const [priceRow] = await leftDb.insert(schema.billingPrices).values({ planId: plan.id, version: 1, countryCode: "US",
      currency: "USD", unitAmount: 1299, interval: "monthly", intervalCount: 1, taxMode: "exclusive",
      providerPriceId: "price_pg", effectiveAt: now }).returning();
    const price: BillingPrice = { id: priceRow.id, planRef: "plus", planVersion: 1, planNameKey: "plans.plus.name",
      planDescriptionKey: "plans.plus.description", providerPriceId: "price_pg", countryCode: "US", currency: "USD",
      unitAmount: 1299, interval: "monthly", intervalCount: 1, taxMode: "exclusive", active: true, effectiveAt: now, expiresAt: null };
    const { order } = await left.createOrGetPendingOrder({ userId: user.id, idempotencyKey: "pg-idem-1",
      requestHash: "a".repeat(64), price });
    event = { id: "evt_pg", type: "invoice.paid", createdAt: now, objectId: "in_pg", objectVersion: 1,
      userId: user.id, orderId: order.id, providerCustomerId: "cus_pg", providerSubscriptionId: "sub_pg",
      providerInvoiceId: "in_pg", providerPaymentId: "pi_pg", providerRefundId: null, providerDisputeId: null,
      amount: 1299, currency: "USD", periodStart: now, periodEnd: new Date(now.getTime() + 86_400_000) };
  }, 60_000);

  afterAll(async () => {
    await Promise.all([leftPool?.end(), rightPool?.end()]);
    if (admin) { await admin.query(`drop schema if exists "${schemaName}" cascade`); await admin.end(); }
  });

  it("applies one event/payment/outbox under true concurrent delivery", async () => {
    const settled = await Promise.allSettled([
      left.applyEvent(event, "b".repeat(64)), right.applyEvent(event, "b".repeat(64)),
    ]);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await leftDb.select().from(schema.billingWebhookEvents)).toHaveLength(1);
    expect(await leftDb.select().from(schema.billingPayments)).toHaveLength(1);
    expect(await leftDb.select().from(schema.billingEntitlementOutbox)).toHaveLength(1);
  });

  it("serializes partial refunds at the payment row across independent pools", async () => {
    await left.applyEvent(event, "b".repeat(64));
    const refund = (id: string, refundId: string, amount: number, version: number): NormalizedBillingEvent => ({
      ...event, id, type: "refund.created", objectId: refundId, objectVersion: version,
      createdAt: new Date(now.getTime() + version * 1_000), providerInvoiceId: null,
      providerRefundId: refundId, amount,
    });
    const gate = await admin.connect();
    let committed = false;
    try {
      await gate.query("begin");
      await gate.query(`set local search_path to "${schemaName}"`);
      await gate.query("select id from billing_payments where provider_invoice_id = $1 for update", ["in_pg"]);

      let arrivals = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const start = async (repository: DrizzleBillingRepository, candidate: NormalizedBillingEvent, hash: string) => {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        return repository.applyEvent(candidate, hash);
      };
      const pending = [
        start(left, refund("evt_pg_refund_600", "re_pg_600", 600, 10), "c".repeat(64)),
        start(right, refund("evt_pg_refund_699", "re_pg_699", 699, 11), "d".repeat(64)),
      ];
      let blocked = 0;
      for (let attempt = 0; attempt < 200 && blocked < 2; attempt += 1) {
        const result = await gate.query<{ count: string }>(`select count(*)::text as count from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock' and query like '%billing_payments%'`);
        blocked = Number(result.rows[0]?.count ?? 0);
        if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const observedBarrier = blocked >= 2;
      await gate.query("commit");
      committed = true;
      const settled = await Promise.allSettled(pending);
      expect(observedBarrier).toBe(true);
      expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    } finally {
      try { if (!committed) await gate.query("rollback"); } finally { gate.release(); }
    }
    const refunds = await leftDb.select().from(schema.billingRefunds);
    expect(refunds).toHaveLength(2);
    expect(refunds.reduce((total, row) => total + row.amount, 0)).toBe(1299);
    expect((await leftDb.select().from(schema.billingOrders))[0]!.status).toBe("refunded");
    expect((await leftDb.select().from(schema.billingSubscriptions))[0]).toEqual(expect.objectContaining({
      status: "expired", entitlementOverride: "refund_full",
    }));
    expect(await leftDb.select().from(schema.billingEntitlementOutbox)).toHaveLength(2);
  });
});
