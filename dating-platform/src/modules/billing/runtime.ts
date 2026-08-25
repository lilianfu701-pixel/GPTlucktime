import "server-only";

import { createHmac } from "node:crypto";

import { createClient } from "redis";

import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { verificationContextRepository } from "@/modules/auth/verification-context-repository";
import { launchVerificationPolicy } from "@/modules/auth/verification-policy";
import { readEnv } from "@/shared/env";
import { BillingEntitlementRefreshWorker, DrizzleEntitlementRefreshStore } from "@/workers/billing-entitlement-worker";

import { RedisBillingRateLimiter } from "./billing-rate-limiter";
import { createPayAuthorizer } from "./billing-pay-authorization";
import { DrizzleBillingRepository } from "./billing-repository";
import { BillingError, CheckoutService } from "./checkout-service";
import { DrizzleReconciliationStore } from "./reconciliation-repository";
import { ReconciliationService } from "./reconciliation-service";
import { createStripeClient, StripeBillingAdapter } from "./stripe-adapter";
import { SubscriptionService } from "./subscription-service";
import { WebhookService } from "./webhook-service";
import { E2eStripeProvider } from "@/modules/e2e/stripe-test-adapter";
import { requireE2eRuntime } from "@/modules/e2e/e2e-guard";

const env = readEnv(process.env);
const e2e = process.env.E2E_MODE === "1" ? requireE2eRuntime(process.env) : null;
const repository = new DrizzleBillingRepository(db);
const redis = createClient({ url: env.REDIS_URL });
const limiter = new RedisBillingRateLimiter(redis, { hmacKey: env.BETTER_AUTH_SECRET });
const authorizePayment = createPayAuthorizer({ contextRepository: verificationContextRepository,
  policy: launchVerificationPolicy });

const configuredStripe = () => {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) throw new Error("BILLING_PROVIDER_UNAVAILABLE");
  return new StripeBillingAdapter({ stripe: createStripeClient(env.STRIPE_SECRET_KEY), webhookSecret: env.STRIPE_WEBHOOK_SECRET });
};
const lazyProvider = {
  createCheckoutSession: (input: Parameters<StripeBillingAdapter["createCheckoutSession"]>[0]) =>
    configuredStripe().createCheckoutSession(input),
};
const lazySubscriptionProvider = {
  setCancelAtPeriodEnd: (input: Parameters<StripeBillingAdapter["setCancelAtPeriodEnd"]>[0]) =>
    configuredStripe().setCancelAtPeriodEnd(input),
};
const lazyVerifier = {
  verifyAndNormalize: (raw: Uint8Array, signature: string) => configuredStripe().verifyAndNormalize(raw, signature),
};
const e2eProvider = e2e ? new E2eStripeProvider(env.APP_URL, process.env.E2E_CONTROL_TOKEN!) : null;
const checkoutProvider = e2eProvider ?? lazyProvider;
const subscriptionProvider = e2eProvider ?? lazySubscriptionProvider;
const billingLimiter = e2e
  ? { async consume() { return { allowed: true, retryAfterSeconds: 0 }; } }
  : limiter;

const checkoutService = new CheckoutService({ store: repository, provider: checkoutProvider, appUrl: env.APP_URL,
  ...(e2e ? { checkoutUrlPolicy: (url: URL) => url.origin === env.APP_URL
    && url.pathname === "/api/e2e/stripe-checkout" } : {}) });
const webhookService = new WebhookService({ verifier: lazyVerifier, store: repository });
const subscriptionService = new SubscriptionService({ store: repository, provider: subscriptionProvider });

export const plansRouteDependencies = {
  list: async (input: { countryCode: string; currency: string; limit: number; after?: string; now: Date }) =>
    repository.listPrices(input),
};
export const checkoutRouteDependencies = {
  getSession: async (headers: Headers) => {
    const session = await auth.api.getSession({ headers });
    return session ? { user: { id: session.user.id } } : null;
  },
  authorizePayment,
  service: checkoutService,
  limiter: billingLimiter,
};
export const stripeWebhookRouteDependencies = { service: webhookService };
export const subscriptionRouteDependencies = {
  getSession: async (headers: Headers) => {
    const session = await auth.api.getSession({ headers });
    return session ? { user: { id: session.user.id, emailVerified: session.user.emailVerified } } : null;
  },
  service: subscriptionService,
  limiter: billingLimiter,
};

export async function runDeletionRenewalCancellation(input: { userId: string; deletionRequestId: string;
  idempotencyKey: string }) {
  void input.deletionRequestId;
  try {
    return await subscriptionService.update(input.userId, { action: "cancel_at_period_end" }, input.idempotencyKey);
  } catch (error) {
    if (error instanceof BillingError && error.code === "SUBSCRIPTION_NOT_AVAILABLE") {
      return { accepted: true, replayed: false, pending: false };
    }
    throw error;
  }
}

export async function runDeletionRenewalResume(input: { userId: string; deletionRequestId: string;
  idempotencyKey: string }) {
  void input.deletionRequestId;
  try {
    return await subscriptionService.update(input.userId, { action: "resume" }, input.idempotencyKey);
  } catch (error) {
    if (error instanceof BillingError && error.code === "SUBSCRIPTION_NOT_AVAILABLE") {
      return { accepted: true, replayed: false, pending: false };
    }
    throw error;
  }
}

export async function runConfiguredBillingWorkers() {
  const entitlement = new BillingEntitlementRefreshWorker({
    store: new DrizzleEntitlementRefreshStore(db),
    invalidate: async (userId) => {
      if (!redis.isOpen) await redis.connect();
      const opaque = createHmac("sha256", env.BETTER_AUTH_SECRET).update(userId).digest("base64url");
      await redis.del(`entitlements:user:${opaque}`);
    },
  });
  const entitlementResult = await entitlement.drain(10);
  const reconciliation = new ReconciliationService({ store: new DrizzleReconciliationStore(db),
    provider: configuredStripe(), batchSize: 25 });
  const day = new Date().toISOString().slice(0, 10);
  try {
    await reconciliation.run(`daily:${day}`);
    return { entitlement: entitlementResult, reconciliation: { runs: 1 } };
  } catch (error) {
    if (error instanceof Error && error.message === "RECONCILIATION_ALREADY_RUNNING") {
      return { entitlement: entitlementResult, reconciliation: { runs: 0 } };
    }
    throw error;
  }
}
