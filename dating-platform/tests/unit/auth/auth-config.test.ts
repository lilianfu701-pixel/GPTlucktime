import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAuthConfiguration } from "@/modules/auth/auth-config";
import { AUTH_CREDENTIAL_TTL_SECONDS } from "@/modules/auth/auth-credentials";
import { InMemoryMessageSender } from "@/modules/auth/message-sender";

describe("Better Auth configuration", () => {
  it("rejects real or malformed email input before free-test account creation", async () => {
    const configuration = createAuthConfiguration({
      database: (() => ({ id: "test" })) as never,
      sender: new InMemoryMessageSender(),
      dispatcher: { assertHealthy: vi.fn(), enqueueEmailVerification: vi.fn(), enqueuePasswordReset: vi.fn(),
        enqueueSmsOtp: vi.fn() },
      secret: "a-secure-test-secret-with-32-characters",
      baseURL: "https://dating.example.test",
      secureCookies: true,
      freeTestMode: true,
    });
    const before = configuration.hooks?.before;
    expect(before).toBeTypeOf("function");
    await expect(before?.({ path: "/sign-up/email", body: { email: "real@example.test" } } as never))
      .rejects.toMatchObject({ body: expect.objectContaining({ code: "FREE_TEST_RECIPIENT_REQUIRED" }) });
    await expect(before?.({ path: "/sign-up/email", body: { email: "tester@datecn.test" } } as never))
      .resolves.toBeUndefined();
    await expect(before?.({ path: "/sign-in/email", body: { email: "real@example.test" } } as never))
      .rejects.toMatchObject({ body: expect.objectContaining({ code: "FREE_TEST_RECIPIENT_REQUIRED" }) });
  });

  it.each([
    ["/sign-up/email", "callbackURL"],
    ["/send-verification-email", "callbackURL"],
    ["/request-password-reset", "redirectTo"],
    ["/sign-in/email", "callbackURL"],
  ] as const)("rejects oversized free-test redirect input on %s", async (path, field) => {
    const configuration = createAuthConfiguration({
      database: (() => ({ id: "test" })) as never,
      sender: new InMemoryMessageSender(),
      dispatcher: { assertHealthy: vi.fn(), enqueueEmailVerification: vi.fn(), enqueuePasswordReset: vi.fn(),
        enqueueSmsOtp: vi.fn() },
      secret: "a-secure-test-secret-with-32-characters",
      baseURL: "https://dating.example.test",
      secureCookies: true,
      freeTestMode: true,
    });
    await expect(configuration.hooks?.before?.({ path,
      body: { email: "tester@datecn.test", [field]: `/${"x".repeat(4_096)}` } } as never))
      .rejects.toMatchObject({ body: expect.objectContaining({ code: "FREE_TEST_REDIRECT_INVALID" }) });
  });

  it("uses UUID ids, verified email/password, rotating secure sessions, phone and 2FA", () => {
    const configuration = createAuthConfiguration({
      database: (() => ({ id: "test" })) as never,
      sender: new InMemoryMessageSender(),
      dispatcher: { assertHealthy: vi.fn(), enqueueEmailVerification: vi.fn(), enqueuePasswordReset: vi.fn(), enqueueSmsOtp: vi.fn() },
      secret: "a-secure-test-secret-with-32-characters",
      baseURL: "https://dating.example.test",
      secureCookies: true,
    });

    expect(configuration.advanced?.database?.generateId).toBe("uuid");
    expect(configuration.advanced?.useSecureCookies).toBe(true);
    expect(configuration.emailAndPassword).toMatchObject({
      enabled: true,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: AUTH_CREDENTIAL_TTL_SECONDS.passwordReset,
    });
    expect(configuration.emailVerification).toMatchObject({
      sendOnSignUp: true,
      sendOnSignIn: true,
      expiresIn: AUTH_CREDENTIAL_TTL_SECONDS.emailVerification,
    });
    expect(configuration.session).toMatchObject({ expiresIn: 604_800, updateAge: 86_400 });
    expect(configuration.plugins?.map((plugin) => plugin.id)).toEqual([
      "two-factor",
      "phone-number",
    ]);
    const twoFactorPlugin = configuration.plugins?.find(({ id }) => id === "two-factor");
    const phonePlugin = configuration.plugins?.find(({ id }) => id === "phone-number");
    expect(phonePlugin?.options).toMatchObject({ expiresIn: AUTH_CREDENTIAL_TTL_SECONDS.phoneOtp });
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
      dispatcher: { assertHealthy: vi.fn(), enqueueEmailVerification, enqueuePasswordReset: vi.fn(), enqueueSmsOtp: vi.fn() },
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
      validUntil: expect.any(Date),
    });
    const queued = enqueueEmailVerification.mock.calls[0]?.[0];
    expect(queued.validUntil.getTime() - Date.now())
      .toBeGreaterThanOrEqual(AUTH_CREDENTIAL_TTL_SECONDS.emailVerification * 1_000 - 100);
    expect(queued.validUntil.getTime() - Date.now())
      .toBeLessThanOrEqual(AUTH_CREDENTIAL_TTL_SECONDS.emailVerification * 1_000);
    expect(sender.emails).toHaveLength(0);
  });
});
