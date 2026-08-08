// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { EntitlementService } from "@/modules/entitlements/entitlement-service";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-08T12:00:00Z");
const TX = { name: "caller-transaction" };
const denied = {
  key: "message.send.daily",
  kind: "quota",
  allowed: false,
  value: null,
  limit: null,
  remaining: 0,
  resetAt: null,
  reason: "SAFETY_RESTRICTED",
  upgradeHint: null,
};

describe("authoritative entitlement consumption", () => {
  it("derives policy, active plan, and time server-side and ignores forged caller fields", async () => {
    const consumeResolvedInTransaction = vi.fn().mockResolvedValue(denied);
    const transaction = vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(TX));
    const timeResolver = vi.fn().mockResolvedValue(NOW);
    const policyResolver = vi.fn().mockResolvedValue({ safetyAllowed: false, verificationSatisfied: true });
    const planResolver = vi.fn().mockResolvedValue("active-plus");
    const service = new EntitlementService({
      store: { transaction, consumeResolvedInTransaction } as never,
      timeResolver,
      policyResolver,
      planResolver,
    } as never);
    const result = await service.consume({
      userId: USER_ID,
      key: "message.send.daily",
      operationId: "00000000-0000-4000-8000-000000000080",
      amount: 1,
      context: {},
      policy: { safetyAllowed: true, verificationSatisfied: true },
      planRef: "forged-plan",
      now: new Date("2000-01-01T00:00:00Z"),
    } as never);

    expect(result).toEqual(denied);
    expect(timeResolver).toHaveBeenCalledWith(TX);
    expect(policyResolver).toHaveBeenCalledWith(TX, USER_ID, "message.send.daily", NOW);
    expect(planResolver).toHaveBeenCalledWith(TX, USER_ID, NOW);
    expect(consumeResolvedInTransaction).toHaveBeenCalledWith(TX, expect.objectContaining({
      policy: { safetyAllowed: false, verificationSatisfied: true },
      planRef: "active-plus",
      now: NOW,
    }));
    expect(consumeResolvedInTransaction.mock.calls[0]![1]).not.toHaveProperty("planRef", "forged-plan");
  });

  it("joins the supplied transaction without opening a nested transaction", async () => {
    const transaction = vi.fn();
    const consumeResolvedInTransaction = vi.fn().mockResolvedValue(denied);
    const service = new EntitlementService({
      store: { transaction, consumeResolvedInTransaction } as never,
      timeResolver: async () => NOW,
      policyResolver: async () => ({ safetyAllowed: false, verificationSatisfied: true }),
      planResolver: async () => null,
    } as never);
    await service.consumeInTransaction(TX, {
      userId: USER_ID,
      key: "message.send.daily",
      operationId: "00000000-0000-4000-8000-000000000081",
      amount: 1,
      context: {},
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(consumeResolvedInTransaction).toHaveBeenCalledOnce();
  });
});
