import { describe, expect, it } from "vitest";

import {
  createVerificationPolicy,
  createVerificationPolicyHandler,
  decideVerification,
  type VerificationPolicyInput,
} from "@/modules/auth/verification-policy";

describe("decideVerification", () => {
  it("requires phone and identity for high-risk messaging", () => {
    expect(
      decideVerification({ selfDeclaredCountryCode: "US", risk: "high", action: "message" }),
    ).toEqual({ email: true, phone: true, liveness: true, identity: true });
  });

  it.each([
    ["low", "browse", { email: true, phone: false, liveness: false, identity: false }],
    ["medium", "browse", { email: true, phone: false, liveness: false, identity: false }],
    ["high", "browse", { email: true, phone: true, liveness: true, identity: true }],
    ["low", "message", { email: true, phone: true, liveness: false, identity: false }],
    ["medium", "message", { email: true, phone: true, liveness: false, identity: false }],
    ["high", "message", { email: true, phone: true, liveness: true, identity: true }],
    ["low", "pay", { email: true, phone: false, liveness: false, identity: true }],
    ["medium", "pay", { email: true, phone: false, liveness: false, identity: true }],
    ["high", "pay", { email: true, phone: true, liveness: true, identity: true }],
  ] as const)("applies the %s/%s policy", (risk, action, expected) => {
    expect(decideVerification({ selfDeclaredCountryCode: "US", risk, action })).toEqual(expected);
  });

  it("allows a later policy provider to replace the launch defaults", async () => {
    const inputs: VerificationPolicyInput[] = [];
    const policy = createVerificationPolicy({
      decide(input) {
        inputs.push(input);
        return { email: true, phone: true, liveness: false, identity: false };
      },
    });

    await expect(
      policy.decide({ selfDeclaredCountryCode: "CA", risk: "medium", action: "browse" }),
    ).resolves.toEqual({ email: true, phone: true, liveness: false, identity: false });
    expect(inputs).toEqual([{ selfDeclaredCountryCode: "CA", risk: "medium", action: "browse" }]);
  });

  it("rejects unauthenticated policy requests without account details", async () => {
    const handler = createVerificationPolicyHandler({
      getSession: async () => null,
      contextRepository: { get: async () => { throw new Error("not called"); } },
    });
    const response = await handler(new Request("https://app.test/api/v1/auth/policy", {
      method: "POST",
      body: JSON.stringify({ action: "message" }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns a stable error when session lookup fails", async () => {
    const handler = createVerificationPolicyHandler({
      getSession: async () => { throw new Error("session backend details"); },
      contextRepository: { get: async () => { throw new Error("not called"); } },
    });
    const response = await handler(new Request("https://app.test/api/v1/auth/policy", {
      method: "POST",
      body: JSON.stringify({ action: "browse" }),
    }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL_ERROR" } });
  });

  it("does not accept client-supplied risk", async () => {
    const handler = createVerificationPolicyHandler({
      getSession: async () => ({ user: { id: crypto.randomUUID() } }),
      contextRepository: { get: async () => { throw new Error("not called"); } },
    });
    const response = await handler(new Request("https://app.test/api/v1/auth/policy", {
      method: "POST",
      body: JSON.stringify({ action: "browse", risk: "low" }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "INVALID_REQUEST" } });
  });

  it("returns only unmet verification types", async () => {
    const handler = createVerificationPolicyHandler({
      getSession: async () => ({ user: { id: "user-id" } }),
      contextRepository: {
        get: async () => ({
          selfDeclaredCountryCode: "US",
          risk: "high",
          satisfied: { email: true, phone: false, liveness: false, identity: false },
        }),
      },
    });
    const response = await handler(new Request("https://app.test/api/v1/auth/policy", {
      method: "POST",
      body: JSON.stringify({ action: "message" }),
    }));

    expect(await response.json()).toEqual({ missing: ["phone", "liveness", "identity"] });
  });

  it("returns a stable internal error when trusted context is unavailable", async () => {
    const handler = createVerificationPolicyHandler({
      getSession: async () => ({ user: { id: "user-id" } }),
      contextRepository: { get: async () => { throw new Error("database details"); } },
    });
    const response = await handler(new Request("https://app.test/api/v1/auth/policy", {
      method: "POST",
      body: JSON.stringify({ action: "browse" }),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL_ERROR" } });
  });
});
