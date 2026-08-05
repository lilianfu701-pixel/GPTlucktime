import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAuthConfiguration } from "@/modules/auth/auth-config";
import { InMemoryMessageSender } from "@/modules/auth/message-sender";

describe("Better Auth configuration", () => {
  it("uses UUID ids, verified email/password, rotating secure sessions, phone and 2FA", () => {
    const configuration = createAuthConfiguration({
      database: (() => ({ id: "test" })) as never,
      sender: new InMemoryMessageSender(),
      dispatcher: { enqueueEmailVerification: vi.fn(), enqueuePasswordReset: vi.fn(), enqueueSmsOtp: vi.fn() },
      secret: "a-secure-test-secret-with-32-characters",
      baseURL: "https://dating.example.test",
      secureCookies: true,
    });

    expect(configuration.advanced?.database?.generateId).toBe("uuid");
    expect(configuration.advanced?.useSecureCookies).toBe(true);
    expect(configuration.emailAndPassword).toMatchObject({
      enabled: true,
      requireEmailVerification: true,
    });
    expect(configuration.emailVerification).toMatchObject({
      sendOnSignUp: true,
      sendOnSignIn: true,
    });
    expect(configuration.session).toMatchObject({ expiresIn: 604_800, updateAge: 86_400 });
    expect(configuration.plugins?.map((plugin) => plugin.id)).toEqual([
      "two-factor",
      "phone-number",
    ]);
    const twoFactorPlugin = configuration.plugins?.find(({ id }) => id === "two-factor");
    const phonePlugin = configuration.plugins?.find(({ id }) => id === "phone-number");
    expect(Object.keys(twoFactorPlugin?.endpoints ?? {})).toEqual(expect.arrayContaining([
      "enableTwoFactor",
      "verifyTOTP",
      "verifyBackupCode",
    ]));
    expect(Object.keys(phonePlugin?.endpoints ?? {})).toEqual(expect.arrayContaining([
      "sendPhoneNumberOTP",
      "verifyPhoneNumber",
      "signInPhoneNumber",
    ]));
  });

  it("awaits durable notification enqueue without contacting the provider", async () => {
    const sender = new InMemoryMessageSender();
    const enqueueEmailVerification = vi.fn().mockResolvedValue(undefined);
    const configuration = createAuthConfiguration({
      database: (() => ({ id: "test" })) as never,
      sender,
      dispatcher: { enqueueEmailVerification, enqueuePasswordReset: vi.fn(), enqueueSmsOtp: vi.fn() },
      secret: "a-secure-test-secret-with-32-characters",
      baseURL: "https://dating.example.test",
      secureCookies: true,
    });

    await configuration.emailVerification?.sendVerificationEmail?.({
      user: { id: crypto.randomUUID(), email: "user@example.test", name: "User", emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
      url: "https://dating.example.test/verify",
      token: "secret-token",
    }, undefined as never);

    expect(enqueueEmailVerification).toHaveBeenCalledWith({
      to: "user@example.test",
      verificationUrl: "https://dating.example.test/verify",
    });
    expect(sender.emails).toHaveLength(0);
  });
});
