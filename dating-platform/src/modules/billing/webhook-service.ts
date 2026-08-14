import { createHash } from "node:crypto";

import { BillingError } from "./checkout-service";
export { BillingError } from "./checkout-service";

export class ProviderEnrichmentError extends Error {
  constructor() { super("PROVIDER_ENRICHMENT_RETRYABLE"); }
}

export type InvoicePaymentLink = {
  providerInvoicePaymentId: string;
  providerPaymentId: string | null;
  providerChargeId: string | null;
};

export type NormalizedBillingEvent = {
  id: string;
  type: "subscription.created" | "subscription.updated" | "subscription.deleted"
    | "invoice.paid" | "invoice.payment_failed" | "refund.created"
    | "dispute.created" | "dispute.closed" | "unknown";
  createdAt: Date;
  objectId: string;
  objectVersion: number;
  userId: string | null;
  orderId: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  providerInvoiceId: string | null;
  providerInvoicePaymentId?: string | null;
  paymentLinks?: InvoicePaymentLink[];
  providerPaymentId: string | null;
  providerChargeId?: string | null;
  providerRefundId: string | null;
  providerDisputeId: string | null;
  amount: number | null;
  currency: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  subscriptionStatus?: "trialing" | "active" | "past_due" | "canceled" | "expired";
  cancelAtPeriodEnd?: boolean;
  disputeStatus?: "needs_review" | "won" | "lost";
  reviewReason?: string;
};

export interface BillingEventVerifier {
  verifyAndNormalize(raw: Uint8Array, signature: string): NormalizedBillingEvent | Promise<NormalizedBillingEvent>;
}

export interface BillingEventStore {
  applyEvent(event: NormalizedBillingEvent, payloadHash: string): Promise<{
    duplicate: boolean; outcome: "applied" | "stale" | "ignored" | "duplicate";
  }>;
}

export class WebhookService {
  constructor(private readonly deps: { verifier: BillingEventVerifier; store: BillingEventStore }) {}

  async handle(raw: Uint8Array, signature: string) {
    let event: NormalizedBillingEvent;
    try { event = await this.deps.verifier.verifyAndNormalize(raw, signature); } catch (error) {
      if (error instanceof ProviderEnrichmentError) throw new BillingError("PROVIDER_UNAVAILABLE");
      throw new BillingError("INVALID_SIGNATURE");
    }
    const payloadHash = createHash("sha256").update(raw).digest("hex");
    const result = await this.deps.store.applyEvent(event, payloadHash);
    return { acknowledged: true, duplicate: result.duplicate };
  }
}
