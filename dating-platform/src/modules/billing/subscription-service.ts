import { createHash } from "node:crypto";

import { z } from "zod";

import { BillingError } from "./checkout-service";

const updateSchema = z.object({ action: z.enum(["cancel_at_period_end", "resume"]) }).strict();
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

type OwnedSubscription = {
  id: string;
  planRef: string;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  providerSubscriptionId: string;
};
type Intent = {
  id: string;
  status: "pending" | "provider_submitted" | "failed";
  action: "cancel_at_period_end" | "resume";
  providerSubscriptionId: string;
  cancelAtPeriodEnd: boolean;
};

export interface SubscriptionStore {
  getOwnedSubscription(userId: string): Promise<OwnedSubscription | null>;
  createOrGetIntent(input: { userId: string; subscriptionId: string; action: Intent["action"];
    idempotencyKey: string; requestHash: string }): Promise<{ intent: Intent; created: boolean }>;
  beginIntentAttempt(id: string): Promise<boolean>;
  markIntentSubmitted(id: string): Promise<void>;
  markIntentFailed(id: string): Promise<void>;
}

export interface SubscriptionProvider {
  setCancelAtPeriodEnd(input: { providerSubscriptionId: string; cancelAtPeriodEnd: boolean;
    idempotencyKey: string }): Promise<void>;
}

export class SubscriptionService {
  constructor(private readonly deps: { store: SubscriptionStore; provider: SubscriptionProvider }) {}

  async get(userId: string) {
    const row = await this.deps.store.getOwnedSubscription(userId);
    return row ? { planRef: row.planRef, status: row.status, currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd } : null;
  }

  async update(userId: string, raw: unknown, idempotencyKey: string) {
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success || !idempotencyPattern.test(idempotencyKey)) throw new BillingError("INVALID_CHECKOUT");
    const subscription = await this.deps.store.getOwnedSubscription(userId);
    if (!subscription) throw new BillingError("SUBSCRIPTION_NOT_AVAILABLE");
    const requestHash = createHash("sha256").update(JSON.stringify({ userId, subscriptionId: subscription.id,
      action: parsed.data.action })).digest("hex");
    const { intent, created } = await this.deps.store.createOrGetIntent({ userId, subscriptionId: subscription.id,
      action: parsed.data.action, idempotencyKey, requestHash });
    if (intent.status === "provider_submitted") return { accepted: true, replayed: true, pending: true };
    if (!await this.deps.store.beginIntentAttempt(intent.id)) throw new BillingError("PROVIDER_UNAVAILABLE");
    try {
      await this.deps.provider.setCancelAtPeriodEnd({ providerSubscriptionId: intent.providerSubscriptionId,
        cancelAtPeriodEnd: intent.action === "cancel_at_period_end", idempotencyKey: `subscription-intent:${intent.id}` });
      await this.deps.store.markIntentSubmitted(intent.id);
      return { accepted: true, replayed: !created, pending: true };
    } catch {
      await this.deps.store.markIntentFailed(intent.id);
      throw new BillingError("PROVIDER_UNAVAILABLE");
    }
  }
}
