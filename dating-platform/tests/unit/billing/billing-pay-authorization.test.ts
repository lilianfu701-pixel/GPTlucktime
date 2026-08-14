import { describe, expect, it, vi } from "vitest";

import { createPayAuthorizer } from "@/modules/billing/billing-pay-authorization";

describe("billing pay authorization", () => {
  it("evaluates the existing verification policy with action pay", async () => {
    const get = vi.fn(async () => ({ selfDeclaredCountryCode: "US", risk: "medium" as const,
      satisfied: { email: true, phone: false, liveness: false, identity: false } }));
    const decide = vi.fn(async () => ({ email: true, phone: false, liveness: false, identity: true }));
    const authorize = createPayAuthorizer({ contextRepository: { get }, policy: { decide } });
    await expect(authorize("user-1")).resolves.toBeNull();
    expect(decide).toHaveBeenCalledWith({ selfDeclaredCountryCode: "US", risk: "medium", action: "pay" });
  });

  it("returns the server-side country when every required verification is satisfied", async () => {
    const get = vi.fn(async () => ({ selfDeclaredCountryCode: "US", risk: "medium" as const,
      satisfied: { email: true, phone: false, liveness: false, identity: true } }));
    const authorize = createPayAuthorizer({ contextRepository: { get }, policy: { decide: async () => ({
      email: true, phone: false, liveness: false, identity: true,
    }) } });
    await expect(authorize("user-1")).resolves.toEqual({ countryCode: "US" });
  });
});
