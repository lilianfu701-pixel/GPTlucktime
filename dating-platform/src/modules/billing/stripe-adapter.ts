import Stripe from "stripe";

import type { CheckoutProvider } from "./checkout-service";
import { ProviderEnrichmentError, type BillingEventVerifier, type InvoicePaymentLink,
  type NormalizedBillingEvent } from "./webhook-service";

const stringId = (value: unknown) => typeof value === "string" ? value
  : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id : null;
const metadataId = (metadata: unknown, key: string) => metadata && typeof metadata === "object"
  && typeof (metadata as Record<string, unknown>)[key] === "string"
  ? (metadata as Record<string, string>)[key]! : null;
const safeDate = (seconds: unknown) => typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0
  ? new Date(seconds * 1_000) : null;
const safeAmount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value)
  && value >= 0 && value <= 1_000_000_000 ? value : null;
const currency = (value: unknown) => typeof value === "string" && /^[a-zA-Z]{3}$/u.test(value)
  ? value.toUpperCase() : null;

const invoicePaymentLink = (value: unknown): InvoicePaymentLink | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.status !== "paid") return null;
  const invoicePaymentId = stringId(row.id);
  const payment = row.payment as Record<string, unknown> | null;
  if (!invoicePaymentId || !payment || typeof payment.type !== "string") return null;
  if (payment.type === "charge") {
    const chargeId = stringId(payment.charge);
    return chargeId ? { providerInvoicePaymentId: invoicePaymentId, providerPaymentId: null,
      providerChargeId: chargeId } : null;
  }
  if (payment.type === "payment_intent") {
    const paymentId = stringId(payment.payment_intent);
    const expanded = payment.payment_intent as Record<string, unknown> | null;
    return paymentId ? { providerInvoicePaymentId: invoicePaymentId, providerPaymentId: paymentId,
      providerChargeId: stringId(expanded?.latest_charge) } : null;
  }
  if (payment.type === "payment_record") {
    const paymentId = stringId(payment.payment_record);
    return paymentId ? { providerInvoicePaymentId: invoicePaymentId, providerPaymentId: paymentId,
      providerChargeId: null } : null;
  }
  return null;
};

const mappedSubscriptionStatus = (status: string) => {
  if (["trialing", "active", "past_due", "canceled"].includes(status)) {
    return status as NonNullable<NormalizedBillingEvent["subscriptionStatus"]>;
  }
  if (status === "incomplete" || status === "paused") return "past_due" as const;
  if (status === "incomplete_expired" || status === "unpaid") return "expired" as const;
  return null;
};

const supported = new Set<NormalizedBillingEvent["type"]>([
  "subscription.created", "subscription.updated", "subscription.deleted", "invoice.paid",
  "invoice.payment_failed", "refund.created", "dispute.created", "dispute.closed",
]);

export class StripeBillingAdapter implements CheckoutProvider, BillingEventVerifier {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly toleranceSeconds: number;
  private readonly nowSeconds: () => number;

  constructor(input: {
    stripe: Stripe; webhookSecret: string; toleranceSeconds?: number; nowSeconds?: () => number;
  }) {
    if (input.webhookSecret.length < 16) throw new Error("STRIPE_WEBHOOK_SECRET_INVALID");
    this.stripe = input.stripe;
    this.webhookSecret = input.webhookSecret;
    this.toleranceSeconds = input.toleranceSeconds ?? 300;
    this.nowSeconds = input.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  }

  async createCheckoutSession(input: Parameters<CheckoutProvider["createCheckoutSession"]>[0]) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: input.providerPriceId, quantity: 1 }],
      ...(input.providerCustomerId ? { customer: input.providerCustomerId } : {}),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
      subscription_data: { metadata: input.metadata },
      allow_promotion_codes: false,
    }, { idempotencyKey: input.idempotencyKey });
    if (!session.url) throw new Error("STRIPE_CHECKOUT_URL_MISSING");
    return { id: session.id, url: session.url };
  }

  async setCancelAtPeriodEnd(input: { providerSubscriptionId: string; cancelAtPeriodEnd: boolean; idempotencyKey: string }) {
    await this.stripe.subscriptions.update(input.providerSubscriptionId,
      { cancel_at_period_end: input.cancelAtPeriodEnd }, { idempotencyKey: input.idempotencyKey });
  }

  async createRefund(input: { providerPaymentId: string; amount: number; idempotencyKey: string }) {
    if (!/^pi_[A-Za-z0-9_]{3,250}$/u.test(input.providerPaymentId)
      || !Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > 1_000_000_000
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(input.idempotencyKey)) {
      throw new Error("INVALID_REFUND_INTENT");
    }
    const refund = await this.stripe.refunds.create({
      payment_intent: input.providerPaymentId,
      amount: input.amount,
    }, { idempotencyKey: input.idempotencyKey });
    if (!refund.id) throw new Error("STRIPE_REFUND_ID_MISSING");
    return { providerRefundId: refund.id };
  }

  async verifyAndNormalize(raw: Uint8Array, signature: string): Promise<NormalizedBillingEvent> {
    const event = this.stripe.webhooks.constructEvent(
      Buffer.from(raw), signature, this.webhookSecret, this.toleranceSeconds, undefined, this.nowSeconds() * 1_000,
    );
    const object = event.data.object as unknown as Record<string, unknown>;
    const rawType = event.type.replace(/^customer\./u, "").replace(/^charge\./u, "");
    let type = supported.has(rawType as NormalizedBillingEvent["type"])
      ? rawType as NormalizedBillingEvent["type"] : "unknown";
    const metadata = object.metadata;
    const subscriptionDetails = object.subscription_details as Record<string, unknown> | null;
    const parent = object.parent as Record<string, unknown> | null;
    const parentSubscription = parent?.subscription_details as Record<string, unknown> | null;
    const subMetadata = subscriptionDetails?.metadata ?? parentSubscription?.metadata;
    let providerPaymentId = stringId(object.payment_intent);
    let providerChargeId = stringId(object.charge);
    const providerSubscriptionId = type.startsWith("subscription.") ? stringId(object.id)
      : stringId(object.subscription) ?? stringId(subscriptionDetails?.subscription) ?? stringId(parentSubscription?.subscription);
    const providerInvoiceId = type.startsWith("invoice.") ? stringId(object.id) : stringId(object.invoice);
    const providerRefundId = type === "refund.created" ? stringId(object.id) : null;
    const providerDisputeId = type === "dispute.created" || type === "dispute.closed" ? stringId(object.id) : null;
    const typeAmount = type === "invoice.paid" ? object.amount_paid
      : type === "invoice.payment_failed" ? object.amount_due : object.amount;
    const periodStart = safeDate(object.period_start ?? (object.current_period_start as unknown));
    const periodEnd = safeDate(object.period_end ?? (object.current_period_end as unknown));
    const rawStatus = typeof object.status === "string" ? object.status : undefined;
    let subscriptionStatus = rawStatus ? mappedSubscriptionStatus(rawStatus) : null;
    let reviewReason: string | undefined;
    let disputeStatus: NormalizedBillingEvent["disputeStatus"];
    if (type === "dispute.created") disputeStatus = "needs_review";
    else if (type === "dispute.closed") {
      if (rawStatus === "won" || rawStatus === "lost") disputeStatus = rawStatus;
      else {
        type = "unknown";
        reviewReason = `UNKNOWN_DISPUTE_STATUS:${rawStatus ?? "missing"}`;
      }
    }
    if (type === "subscription.deleted") subscriptionStatus = "canceled";
    else if (type === "subscription.created" || type === "subscription.updated") {
      if (!rawStatus || !subscriptionStatus) {
        type = "unknown";
        subscriptionStatus = "expired";
        reviewReason = `UNKNOWN_SUBSCRIPTION_STATUS:${rawStatus ?? "missing"}`;
      }
    }
    let providerInvoicePaymentId: string | null = null;
    let paymentLinks: InvoicePaymentLink[] = [];
    if (type === "invoice.paid" && providerInvoiceId) {
      const relation = object.payments as { data?: unknown[]; has_more?: boolean } | null;
      const included = relation?.data ?? [];
      paymentLinks = included.map(invoicePaymentLink).filter((value): value is InvoicePaymentLink => value !== null);
      if (!relation || relation.has_more === true) {
        try {
          let startingAfter = relation?.has_more ? stringId(included.at(-1) && (included.at(-1) as Record<string, unknown>).id) : null;
          const seen = new Set<string>();
          let complete = false;
          for (let pageCount = 0; pageCount < 1_000; pageCount += 1) {
            const page = await this.stripe.invoicePayments.list({ invoice: providerInvoiceId, status: "paid", limit: 100,
              ...(startingAfter ? { starting_after: startingAfter } : {}),
              expand: ["data.payment.charge", "data.payment.payment_intent"] });
            paymentLinks.push(...(page.data as unknown[]).map(invoicePaymentLink)
              .filter((value): value is InvoicePaymentLink => value !== null));
            if (!page.has_more) { complete = true; break; }
            const next = stringId((page.data as unknown[]).at(-1));
            if (!next || seen.has(next)) throw new Error("INVOICE_PAYMENT_CURSOR_INVALID");
            seen.add(next);
            startingAfter = next;
          }
          if (!complete) throw new Error("INVOICE_PAYMENT_PAGE_LIMIT");
        } catch {
          throw new ProviderEnrichmentError();
        }
      }
      paymentLinks = [...new Map(paymentLinks.map((link) => [link.providerInvoicePaymentId, link])).values()];
      const firstLink = paymentLinks[0];
      if (firstLink) {
        providerInvoicePaymentId = firstLink.providerInvoicePaymentId;
        providerPaymentId = firstLink.providerPaymentId;
        providerChargeId = firstLink.providerChargeId;
      } else {
        type = "unknown";
        reviewReason = `INVOICE_PAYMENT_LINK_MISSING:${providerInvoiceId}`;
      }
    }
    return {
      id: event.id,
      type,
      createdAt: new Date(event.created * 1_000),
      objectId: stringId(object.id) ?? "unknown",
      objectVersion: event.created,
      userId: metadataId(metadata, "userId") ?? metadataId(subMetadata, "userId"),
      orderId: metadataId(metadata, "orderId") ?? metadataId(subMetadata, "orderId"),
      providerCustomerId: stringId(object.customer),
      providerSubscriptionId,
      providerInvoiceId,
      providerInvoicePaymentId,
      ...(paymentLinks.length ? { paymentLinks } : {}),
      providerPaymentId,
      providerChargeId,
      providerRefundId,
      providerDisputeId,
      amount: safeAmount(typeAmount),
      currency: currency(object.currency),
      periodStart,
      periodEnd,
      ...(subscriptionStatus ? { subscriptionStatus } : {}),
      ...(typeof object.cancel_at_period_end === "boolean" ? { cancelAtPeriodEnd: object.cancel_at_period_end } : {}),
      ...(disputeStatus ? { disputeStatus } : {}),
      ...(reviewReason ? { reviewReason } : {}),
    };
  }

  async listLedgerPage(input: { cursor: string | null; limit: number }) {
    const limit = Math.max(1, Math.min(25, Math.floor(input.limit)));
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
    const stripe = this.stripe as unknown as {
      subscriptions: { list(input: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>>; has_more: boolean }> };
      invoices: { list(input: Stripe.InvoiceListParams): Promise<{ data: Array<Record<string, unknown>>; has_more: boolean }> };
      refunds: { list(input: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>>; has_more: boolean }> };
      disputes: { list(input: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>>; has_more: boolean }> };
    };
    const donePage = { data: [] as Array<Record<string, unknown>>, has_more: false };
    const [subscriptions, invoices, refunds, disputes] = await Promise.all([
      cursor.s === "-" ? donePage
        : stripe.subscriptions.list({ status: "all", limit, ...(cursor.s ? { starting_after: cursor.s } : {}) }),
      cursor.i === "-" ? donePage
        : stripe.invoices.list({ status: "paid", limit, ...(cursor.i ? { starting_after: cursor.i } : {}) }),
      cursor.r === "-" ? donePage
        : stripe.refunds.list({ limit, ...(cursor.r ? { starting_after: cursor.r } : {}) }),
      cursor.d === "-" ? donePage
        : stripe.disputes.list({ limit, ...(cursor.d ? { starting_after: cursor.d } : {}) }),
    ]);
    const map = (rows: Array<Record<string, unknown>>, amountKey?: string) => rows.flatMap((row) => {
      const id = stringId(row.id);
      if (!id) return [];
      const amount = amountKey ? safeAmount(row[amountKey]) : undefined;
      return [{ id, ...(typeof row.status === "string" ? { status: row.status } : {}),
        ...(amount !== undefined && amount !== null ? { amount } : {}) }];
    });
    const position = (page: { data: Array<Record<string, unknown>>; has_more: boolean }, previous?: string) =>
      previous === "-" || !page.has_more ? "-" : stringId(page.data.at(-1)?.id) ?? previous;
    const next = { s: position(subscriptions, cursor.s), i: position(invoices, cursor.i),
      r: position(refunds, cursor.r), d: position(disputes, cursor.d) };
    const complete = Object.values(next).every((value) => value === "-");
    return { subscriptions: map(subscriptions.data),
      invoices: map(invoices.data.filter((row) => row.status === "paid"), "amount_paid"),
      refunds: map(refunds.data, "amount"), disputes: map(disputes.data, "amount"),
      nextCursor: complete ? null : Buffer.from(JSON.stringify(next), "utf8").toString("base64url") };
  }
}

export const createStripeClient = (secretKey: string) => new Stripe(secretKey, {
  apiVersion: "2026-07-29.dahlia",
  maxNetworkRetries: 2,
  timeout: 20_000,
  telemetry: false,
  emitEventBodies: false,
});
