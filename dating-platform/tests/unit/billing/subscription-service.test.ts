import { describe, expect, it, vi } from "vitest";

import { BillingError } from "@/modules/billing/checkout-service";
import { SubscriptionService } from "@/modules/billing/subscription-service";

const subscription = { id: "sub-row-1", planRef: "plus", status: "active", currentPeriodEnd: new Date("2026-09-01"),
  cancelAtPeriodEnd: false, providerSubscriptionId: "sub_provider_1" };

describe("SubscriptionService", () => {
  it("returns only the safe current subscription projection", async () => {
    const store = { getOwnedSubscription: vi.fn(async () => subscription) };
    const result = await new SubscriptionService({ store: store as never, provider: {} as never }).get("user-1");
    expect(result).toEqual({ planRef: "plus", status: "active", currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: false });
    expect(JSON.stringify(result)).not.toMatch(/provider|sub-row|user/iu);
  });

  it("persists an idempotent intent before provider submission and leaves webhook projection authoritative", async () => {
    const intent = { id: "intent-1", status: "pending" as const, action: "cancel_at_period_end" as const,
      providerSubscriptionId: "sub_provider_1", cancelAtPeriodEnd: false };
    const store = { getOwnedSubscription: vi.fn(async () => subscription),
      createOrGetIntent: vi.fn(async () => ({ intent, created: true })), markIntentSubmitted: vi.fn(async () => undefined),
      markIntentFailed: vi.fn(async () => undefined), beginIntentAttempt: vi.fn(async () => true) };
    const provider = { setCancelAtPeriodEnd: vi.fn(async () => undefined) };
    const service = new SubscriptionService({ store: store as never, provider });
    await expect(service.update("user-1", { action: "cancel_at_period_end" }, "manage-12345678"))
      .resolves.toEqual({ accepted: true, replayed: false, pending: true });
    expect(store.createOrGetIntent.mock.invocationCallOrder[0]).toBeLessThan(provider.setCancelAtPeriodEnd.mock.invocationCallOrder[0]!);
    expect(provider.setCancelAtPeriodEnd).toHaveBeenCalledWith({ providerSubscriptionId: "sub_provider_1",
      cancelAtPeriodEnd: true, idempotencyKey: "subscription-intent:intent-1" });
    expect(store.markIntentSubmitted).toHaveBeenCalledWith("intent-1");
    expect(subscription.cancelAtPeriodEnd).toBe(false);
  });

  it("replays a submitted intent without another provider call and retries a failed intent safely", async () => {
    const provider = { setCancelAtPeriodEnd: vi.fn().mockRejectedValueOnce(new Error("provider secret")).mockResolvedValue(undefined) };
    const failedIntent = { id: "intent-2", status: "failed" as const, action: "resume" as const,
      providerSubscriptionId: "sub_provider_1", cancelAtPeriodEnd: true };
    const store = { getOwnedSubscription: vi.fn(async () => ({ ...subscription, cancelAtPeriodEnd: true })),
      createOrGetIntent: vi.fn(async () => ({ intent: failedIntent, created: false })),
      markIntentSubmitted: vi.fn(async () => undefined), markIntentFailed: vi.fn(async () => undefined),
      beginIntentAttempt: vi.fn(async () => true) };
    const service = new SubscriptionService({ store: store as never, provider });
    await expect(service.update("user-1", { action: "resume" }, "manage-87654321"))
      .rejects.toEqual(new BillingError("PROVIDER_UNAVAILABLE"));
    await expect(service.update("user-1", { action: "resume" }, "manage-87654321")).resolves.toMatchObject({ accepted: true });
    expect(provider.setCancelAtPeriodEnd).toHaveBeenCalledTimes(2);
    expect(provider.setCancelAtPeriodEnd.mock.calls[0]).toEqual(provider.setCancelAtPeriodEnd.mock.calls[1]);

    store.createOrGetIntent.mockResolvedValueOnce({ intent: { ...failedIntent, status: "provider_submitted" }, created: false } as never);
    await expect(service.update("user-1", { action: "resume" }, "manage-87654321"))
      .resolves.toEqual({ accepted: true, replayed: true, pending: true });
    expect(provider.setCancelAtPeriodEnd).toHaveBeenCalledTimes(2);
  });
});
