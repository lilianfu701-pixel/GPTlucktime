# Task11 Billing Quality Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven remaining billing quality findings without weakening authentication, monetary constraints, immutable payment facts, or webhook acknowledgement safety.

**Architecture:** Checkout derives market selection from the verified server-side country and serializes ownership in the database before any provider creation. Webhooks persist invoice payment relations separately from the once-per-invoice payment fact, and entitlement reversals are scoped to the payment that currently funds the subscription. Reconciliation checkpoints both forward progress and comparison cursors, then compares bounded ordered chunks instead of loading the entire staged ledger.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Drizzle ORM/PostgreSQL, Stripe Node SDK, Vitest, PGlite, optional real PostgreSQL integration gate.

**Execution constraint:** Do not stage or commit, do not run the full repository suite, do not enter Task12, and do not run package-manager or install commands.

---

### Task 1: Verified country controls checkout pricing

**Files:**
- Modify: `src/modules/billing/billing-pay-authorization.ts`
- Modify: `src/modules/billing/billing-route.ts`
- Modify: `src/modules/billing/checkout-service.ts`
- Test: `tests/unit/billing/billing-pay-authorization.test.ts`
- Test: `tests/unit/billing/billing-route.test.ts`
- Test: `tests/unit/billing/checkout-service.test.ts`

- [ ] Change the pay authorizer success result from `boolean` to `{ countryCode: string }`, validating the authoritative country as uppercase ISO alpha-2.
- [ ] Add route tests proving policy denial/error happens before body, limiter, database, and Stripe; add a success test proving the authoritative country is passed to checkout.
- [ ] Make checkout accept `planRef` with optional client currency only, select by authoritative country, and reject a supplied currency that differs from the selected server offer.
- [ ] Run the three focused unit files and record exact RED/GREEN counts.

### Task 2: Serialize checkout ownership and contain duplicate subscriptions

**Files:**
- Modify: `src/db/schema/billing.ts`
- Modify: `drizzle/0038_billing.sql`
- Modify: `src/modules/billing/billing-repository.ts`
- Modify: `src/modules/billing/checkout-service.ts`
- Modify: `src/modules/billing/webhook-service.ts`
- Test: `tests/unit/billing/checkout-service.test.ts`
- Test: `tests/integration/billing/webhook-idempotency.test.ts`
- Test: `tests/integration/billing/webhook-concurrency-postgres.test.ts`

- [ ] Add failing tests for active-owner rejection and two different idempotency keys racing for one user.
- [ ] Add a per-user checkout guard row/advisory lock transaction that checks a current subscription and reuses one pending/session-created order before provider creation.
- [ ] Add a failing webhook test for a second provider subscription after the owner already has a current paid subscription.
- [ ] Persist the second provider fact and payment exactly once, mark it review/compensation-required, and never enqueue a second paid entitlement.
- [ ] Run focused checkout and webhook tests and record exact RED/GREEN counts.

### Task 3: Concurrent partial refunds

**Files:**
- Modify: `src/modules/billing/billing-repository.ts`
- Modify: `drizzle/0038_billing.sql`
- Test: `tests/integration/billing/webhook-idempotency.test.ts`
- Test: `tests/integration/billing/webhook-concurrency-postgres.test.ts`

- [ ] Add a PGlite sequential partial-refund test that reaches the original payment amount exactly once.
- [ ] Add a real PostgreSQL two-pool barrier test that submits concurrent partial refunds against one payment.
- [ ] Lock the payment row before refund insertion and aggregate validation; reject over-refund inside the same transaction.
- [ ] Make the full-refund order/override transition idempotent so the terminal transition and entitlement outbox happen once.
- [ ] Run both integration files and record exact RED/GREEN counts, preserving the existing real-Postgres environment skip.

### Task 4: Disable promotions

**Files:**
- Modify: `src/modules/billing/stripe-adapter.ts`
- Test: `tests/unit/billing/stripe-adapter.test.ts`
- Test: `tests/unit/billing/checkout-service.test.ts`

- [ ] Add a failing Stripe adapter assertion that promotion codes are false or omitted and that the only line item is the server-selected provider price.
- [ ] Set `allow_promotion_codes: false` in checkout session creation.
- [ ] Run the focused adapter and checkout tests and record exact RED/GREEN counts.

### Task 5: Persist every paid InvoicePayment relation

**Files:**
- Modify: `src/db/schema/billing.ts`
- Modify: `drizzle/0038_billing.sql`
- Modify: `src/modules/billing/stripe-adapter.ts`
- Modify: `src/modules/billing/webhook-service.ts`
- Modify: `src/modules/billing/billing-repository.ts`
- Test: `tests/unit/billing/stripe-adapter.test.ts`
- Test: `tests/unit/billing/webhook-service.test.ts`
- Test: `tests/integration/billing/webhook-idempotency.test.ts`

- [ ] Add a failing adapter test with more than ten paid relations across multiple pages, including payment-intent, charge, and payment-record relations.
- [ ] Normalize `paymentLinks[]`, paginate until `has_more` is false with a strict cursor cycle/page bound, and retain legacy singular IDs only as derived compatibility fields if required.
- [ ] Add `billing_invoice_payment_links` as an immutable relation table keyed by provider InvoicePayment ID and indexed by provider payment/charge IDs.
- [ ] Persist the invoice payment amount once in `billing_payments`, persist all relations idempotently, and resolve refunds/disputes through any relation.
- [ ] Add tests proving a refund and dispute tied to the second or later relation resolve the single invoice payment without duplicate amount facts.
- [ ] Regenerate migration 0038 and re-append required custom constraints/triggers before running schema drift checks.

### Task 6: Historic refunds do not revoke the current renewal

**Files:**
- Modify: `src/db/schema/billing.ts`
- Modify: `drizzle/0038_billing.sql`
- Modify: `src/modules/billing/billing-repository.ts`
- Test: `tests/integration/billing/webhook-idempotency.test.ts`

- [ ] Add a failing test with an old fully refunded invoice and a newer paid invoice on the same subscription.
- [ ] Persist the subscription's current entitlement-source payment/invoice when an invoice is accepted as the current paid period.
- [ ] Always retain refund and order terminal facts, but set `refund_full` only when the refunded payment matches the current entitlement source.
- [ ] Prove a current-period full refund still revokes while a historic full refund does not.

### Task 7: Bounded resumable reconciliation comparison

**Files:**
- Modify: `src/db/schema/billing.ts`
- Modify: `drizzle/0038_billing.sql`
- Modify: `src/modules/billing/reconciliation-repository.ts`
- Modify: `src/modules/billing/reconciliation-service.ts`
- Test: `tests/unit/billing/reconciliation-service.test.ts`
- Test: `tests/integration/billing/webhook-idempotency.test.ts`

- [ ] Add a failing repeated-cursor test that proves a run checkpoints retry/backoff instead of hot-looping.
- [ ] Persist the last cursor/progress count per collection phase and reject unchanged/repeated cursors with a stable reconciliation cursor-cycle error.
- [ ] Add ordered chunk readers for provider/internal staging and a persisted compare cursor.
- [ ] Replace `loadCollected()` full snapshots with a bounded merge that saves discrepancies per chunk and checkpoints compare progress across ticks.
- [ ] Add a large staged-ledger test that asserts bounded read sizes and multiple comparison ticks.

### Task 8: Final verification

**Files:**
- Verify all modified billing and migration files.

- [ ] Run `node_modules\\.bin\\vitest.cmd run tests\\unit\\billing tests\\integration\\billing`.
- [ ] Run `node_modules\\.bin\\tsc.cmd --noEmit`.
- [ ] Run focused ESLint for billing source/schema/tests.
- [ ] Run `node_modules\\.bin\\drizzle-kit.cmd check` and `node_modules\\.bin\\drizzle-kit.cmd generate`, confirming no 0039 migration.
- [ ] Run `git diff --check`, inspect status, and report exact counts without staging or committing.
