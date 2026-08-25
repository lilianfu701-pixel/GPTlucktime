import { createHash } from "node:crypto";

import { z } from "zod";

export type BillingErrorCode =
  | "INVALID_CHECKOUT" | "PRICE_NOT_AVAILABLE" | "IDEMPOTENCY_CONFLICT"
  | "CUSTOMER_NOT_AVAILABLE" | "SUBSCRIPTION_NOT_AVAILABLE" | "CHECKOUT_NOT_AVAILABLE"
  | "PROVIDER_UNAVAILABLE" | "INVALID_SIGNATURE";

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode) { super(code); }
}

export type BillingPrice = {
  id: string;
  planRef: string;
  planVersion: number;
  priceVersion?: number;
  planNameKey: string;
  planDescriptionKey: string;
  providerPriceId: string;
  countryCode: string;
  currency: string;
  unitAmount: number;
  interval: "monthly" | "quarterly" | "yearly";
  intervalCount: number;
  taxMode: "inclusive" | "exclusive";
  active: boolean;
  effectiveAt: Date;
  expiresAt: Date | null;
};

export type PendingOrder = {
  id: string;
  userId: string;
  price: BillingPrice;
  providerSessionId: string | null;
  checkoutUrl: string | null;
};

export type CheckoutStore = {
  selectPrice(input: { planRef: string; countryCode: string; currency?: string; now: Date }): Promise<BillingPrice | null>;
  createOrGetPendingOrder(input: {
    userId: string; idempotencyKey: string; requestHash: string; price: BillingPrice;
  }): Promise<{ order: PendingOrder; created: boolean }>;
  assertCustomerOwnership(userId: string): Promise<string | void>;
  attachProviderSession(orderId: string, session: { id: string; url: string }): Promise<void>;
  recordProviderFailure(orderId: string): Promise<void>;
};

export type CheckoutProvider = {
  createCheckoutSession(input: {
    providerPriceId: string;
    providerCustomerId?: string;
    successUrl: string;
    cancelUrl: string;
    metadata: { orderId: string; userId: string; priceId: string; planVersion: string };
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
};

const inputSchema = z.object({
  planRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u),
  currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
}).strict();
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function selectPublicPlans(prices: BillingPrice[], input: {
  countryCode: string; currency: string; now: Date; limit?: number;
}) {
  const limit = Math.max(1, Math.min(20, input.limit ?? 20));
  return prices.filter((price) => price.active
    && price.countryCode === input.countryCode && price.currency === input.currency
    && price.effectiveAt <= input.now && (!price.expiresAt || price.expiresAt > input.now))
    .slice(0, limit).map((price) => ({
      planRef: price.planRef,
      nameKey: price.planNameKey,
      descriptionKey: price.planDescriptionKey,
      price: {
        currency: price.currency, unitAmount: price.unitAmount, interval: price.interval,
        intervalCount: price.intervalCount, taxMode: price.taxMode,
      },
    }));
}

export class CheckoutService {
  constructor(private readonly deps: {
    store: CheckoutStore; provider: CheckoutProvider; appUrl: string; clock?: () => Date;
    checkoutUrlPolicy?: (url: URL) => boolean;
  }) {
    const app = new URL(deps.appUrl);
    if (!(["http:", "https:"] as string[]).includes(app.protocol) || app.origin !== deps.appUrl
      || app.username || app.password) throw new Error("INVALID_APP_URL");
  }

  async create(userId: string, raw: unknown, idempotencyKey: string, authoritativeCountryCode: string) {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success || !idempotencyPattern.test(idempotencyKey)
      || !/^[A-Z]{2}$/u.test(authoritativeCountryCode)) throw new BillingError("INVALID_CHECKOUT");
    const now = this.deps.clock?.() ?? new Date();
    const price = await this.deps.store.selectPrice({ planRef: parsed.data.planRef,
      countryCode: authoritativeCountryCode, now });
    if (!price || !price.active || price.effectiveAt > now || (price.expiresAt && price.expiresAt <= now)) {
      throw new BillingError("PRICE_NOT_AVAILABLE");
    }
    if (price.countryCode !== authoritativeCountryCode
      || (parsed.data.currency !== undefined && price.currency !== parsed.data.currency)) {
      throw new BillingError("PRICE_NOT_AVAILABLE");
    }
    const ownedCustomer = await this.deps.store.assertCustomerOwnership(userId);
    const requestHash = createHash("sha256").update(JSON.stringify({ userId, planRef: parsed.data.planRef,
      countryCode: authoritativeCountryCode, currency: price.currency, priceId: price.id })).digest("hex");
    const { order, created } = await this.deps.store.createOrGetPendingOrder({ userId, idempotencyKey, requestHash, price });
    if (order.userId !== userId || order.price.id !== price.id) throw new BillingError("IDEMPOTENCY_CONFLICT");
    if (order.providerSessionId && order.checkoutUrl) {
      return { orderId: order.id, checkoutUrl: order.checkoutUrl, replayed: true };
    }
    try {
      const session = await this.deps.provider.createCheckoutSession({
        providerPriceId: price.providerPriceId,
        ...(typeof ownedCustomer === "string" ? { providerCustomerId: ownedCustomer } : {}),
        successUrl: `${this.deps.appUrl}/billing/return?status=success`,
        cancelUrl: `${this.deps.appUrl}/billing/return?status=cancel`,
        metadata: { orderId: order.id, userId, priceId: price.id, planVersion: String(price.planVersion) },
        idempotencyKey: `checkout:${order.id}`,
      });
      const checkoutUrl = new URL(session.url);
      const trustedStripe = checkoutUrl.protocol === "https:"
        && (checkoutUrl.hostname === "stripe.com" || checkoutUrl.hostname.endsWith(".stripe.com"));
      if ((!trustedStripe && !this.deps.checkoutUrlPolicy?.(checkoutUrl))
        || checkoutUrl.username || checkoutUrl.password) throw new Error("UNTRUSTED_CHECKOUT_URL");
      await this.deps.store.attachProviderSession(order.id, { id: session.id, url: session.url });
      return { orderId: order.id, checkoutUrl: session.url, replayed: !created };
    } catch {
      await this.deps.store.recordProviderFailure(order.id);
      throw new BillingError("PROVIDER_UNAVAILABLE");
    }
  }
}
