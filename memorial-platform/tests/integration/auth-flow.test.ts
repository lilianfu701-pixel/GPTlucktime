import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  emailCredentials,
  loginAttempts,
  loginChallenges,
  phoneCredentials,
  users,
} from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import {
  InMemoryEmailProvider,
  setEmailProvider,
} from "@/modules/auth/providers/email";
import { InMemorySmsProvider, setSmsProvider } from "@/modules/auth/providers/sms";
import { requestEmailCode, requestPhoneCode, verifyCode } from "@/modules/auth/service";
import { resolveSession } from "@/modules/auth/sessions";

let email: InMemoryEmailProvider;
let sms: InMemorySmsProvider;
const touchedDestinations: string[] = [];

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
});

beforeEach(() => {
  email = new InMemoryEmailProvider();
  sms = new InMemorySmsProvider();
  setEmailProvider(email);
  setSmsProvider(sms);
});

afterEach(async () => {
  setEmailProvider(null);
  setSmsProvider(null);
  delete process.env.PHONE_AUTH_ENABLED;
  delete process.env.PHONE_AUTH_REGIONS;
  resetEnvCache();

  const destinations = touchedDestinations.splice(0);
  if (destinations.length === 0) {
    return;
  }

  const challenges = await db()
    .select({ id: loginChallenges.id })
    .from(loginChallenges)
    .where(inArray(loginChallenges.destination, destinations));
  if (challenges.length > 0) {
    await db()
      .delete(loginAttempts)
      .where(inArray(loginAttempts.challengeId, challenges.map((row) => row.id)));
  }
  await db()
    .delete(loginChallenges)
    .where(inArray(loginChallenges.destination, destinations));

  const emailOwners = await db()
    .select({ userId: emailCredentials.userId })
    .from(emailCredentials)
    .where(inArray(emailCredentials.email, destinations));
  const phoneOwners = await db()
    .select({ userId: phoneCredentials.userId })
    .from(phoneCredentials)
    .where(inArray(phoneCredentials.phoneE164, destinations));

  const owners = [...emailOwners, ...phoneOwners].map((row) => row.userId);
  if (owners.length > 0) {
    await db().delete(users).where(inArray(users.id, owners));
  }
});

afterAll(async () => {
  await closeDb();
});

function freshEmail(): string {
  const value = `flow-${randomUUID()}@example.test`;
  touchedDestinations.push(value);
  return value;
}

describe("email sign-in", () => {
  it("creates an account on first successful sign-in", async () => {
    const address = freshEmail();

    const requested = await requestEmailCode({ email: address, locale: "zh-CN" });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const code = email.lastCodeFor(address);
    expect(code).toMatch(/^\d{6}$/);

    const verified = await verifyCode({
      challengeId: requested.value.challengeId,
      code: code ?? "",
      expectedChannel: "email",
      locale: "zh-CN",
    });

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const [credential] = await db()
      .select()
      .from(emailCredentials)
      .where(eq(emailCredentials.email, address));

    expect(credential?.userId).toBe(verified.value.userId);
    expect(credential?.verifiedAt).toBeInstanceOf(Date);

    const [account] = await db()
      .select()
      .from(users)
      .where(eq(users.id, verified.value.userId));
    // The locale the person signed in with becomes their starting preference.
    expect(account?.preferredLocale).toBe("zh-CN");
  });

  it("returns the same account on a second sign-in", async () => {
    const address = freshEmail();

    const first = await requestEmailCode({ email: address, locale: "en" });
    if (!first.ok) throw new Error("request failed");
    const firstVerified = await verifyCode({
      challengeId: first.value.challengeId,
      code: email.lastCodeFor(address) ?? "",
      expectedChannel: "email",
    });

    const second = await requestEmailCode({ email: address, locale: "en" });
    if (!second.ok) throw new Error("request failed");
    const secondVerified = await verifyCode({
      challengeId: second.value.challengeId,
      code: email.lastCodeFor(address) ?? "",
      expectedChannel: "email",
    });

    expect(firstVerified.ok && secondVerified.ok).toBe(true);
    if (!firstVerified.ok || !secondVerified.ok) return;
    expect(secondVerified.value.userId).toBe(firstVerified.value.userId);

    const credentials = await db()
      .select()
      .from(emailCredentials)
      .where(eq(emailCredentials.email, address));
    expect(credentials).toHaveLength(1);
  });

  it("treats a differently cased address as the same person", async () => {
    const address = freshEmail();

    const first = await requestEmailCode({ email: address, locale: "en" });
    if (!first.ok) throw new Error("request failed");
    const firstVerified = await verifyCode({
      challengeId: first.value.challengeId,
      code: email.lastCodeFor(address) ?? "",
      expectedChannel: "email",
    });

    const shouted = address.toUpperCase();
    const second = await requestEmailCode({ email: shouted, locale: "en" });
    if (!second.ok) throw new Error("request failed");
    // Normalization means the code was addressed to the lowercase form.
    const secondVerified = await verifyCode({
      challengeId: second.value.challengeId,
      code: email.lastCodeFor(address) ?? "",
      expectedChannel: "email",
    });

    expect(firstVerified.ok && secondVerified.ok).toBe(true);
    if (!firstVerified.ok || !secondVerified.ok) return;
    expect(secondVerified.value.userId).toBe(firstVerified.value.userId);
  });

  it("issues a session that resolves to the signed-in person", async () => {
    const address = freshEmail();
    const requested = await requestEmailCode({ email: address, locale: "en" });
    if (!requested.ok) throw new Error("request failed");

    const verified = await verifyCode({
      challengeId: requested.value.challengeId,
      code: email.lastCodeFor(address) ?? "",
      expectedChannel: "email",
    });
    if (!verified.ok) throw new Error("verify failed");

    const resolved = await resolveSession({ token: verified.value.token });
    expect(resolved.ok && resolved.value.userId).toBe(verified.value.userId);
  });

  it("rejects a malformed address without issuing a challenge", async () => {
    const before = await db().select().from(loginChallenges);
    expect(await requestEmailCode({ email: "not-an-address", locale: "en" })).toEqual({
      ok: false,
      error: "INVALID_EMAIL",
    });
    const after = await db().select().from(loginChallenges);

    expect(after).toHaveLength(before.length);
    expect(email.sent).toHaveLength(0);
  });

  it("does not create an account when the code is wrong", async () => {
    const address = freshEmail();
    const requested = await requestEmailCode({ email: address, locale: "en" });
    if (!requested.ok) throw new Error("request failed");

    const verified = await verifyCode({
      challengeId: requested.value.challengeId,
      code: "000000",
      expectedChannel: "email",
    });

    expect(verified.ok).toBe(false);
    const credentials = await db()
      .select()
      .from(emailCredentials)
      .where(eq(emailCredentials.email, address));
    expect(credentials).toHaveLength(0);
  });

  it("refuses a phone code presented to the email channel", async () => {
    // The channel is part of the challenge, so a code delivered by SMS cannot be
    // redeemed as proof of owning an address.
    process.env.PHONE_AUTH_ENABLED = "true";
    process.env.PHONE_AUTH_REGIONS = "US";
    resetEnvCache();

    const phone = "+14155550199";
    touchedDestinations.push(phone);

    const requested = await requestPhoneCode({
      phone,
      region: "US",
      locale: "en",
    });
    if (!requested.ok) throw new Error("phone request failed");

    const verified = await verifyCode({
      challengeId: requested.value.challengeId,
      code: sms.lastCodeFor(phone) ?? "",
      expectedChannel: "email",
    });

    expect(verified).toEqual({ ok: false, error: "CHANNEL_MISMATCH" });
  });
});

describe("phone sign-in availability", () => {
  it("is refused while the feature switch is off", async () => {
    // Phase one ships this path complete but hidden.
    expect(
      await requestPhoneCode({ phone: "+14155550100", region: "US", locale: "en" }),
    ).toEqual({ ok: false, error: "FEATURE_DISABLED" });
    expect(sms.sent).toHaveLength(0);
  });

  it("is refused for a region that is not on the allow list", async () => {
    process.env.PHONE_AUTH_ENABLED = "true";
    process.env.PHONE_AUTH_REGIONS = "US";
    resetEnvCache();

    expect(
      await requestPhoneCode({ phone: "+8613800138000", region: "CN", locale: "en" }),
    ).toEqual({ ok: false, error: "FEATURE_DISABLED" });
    expect(sms.sent).toHaveLength(0);
  });

  it("is refused when the switch is on but no region is listed", async () => {
    process.env.PHONE_AUTH_ENABLED = "true";
    resetEnvCache();

    expect(
      await requestPhoneCode({ phone: "+14155550100", region: "US", locale: "en" }),
    ).toEqual({ ok: false, error: "FEATURE_DISABLED" });
  });

  it("completes end to end once enabled for the region", async () => {
    process.env.PHONE_AUTH_ENABLED = "true";
    process.env.PHONE_AUTH_REGIONS = "US";
    resetEnvCache();

    const phone = "+14155550188";
    touchedDestinations.push(phone);

    const requested = await requestPhoneCode({
      phone: "+1 (415) 555-0188",
      region: "US",
      locale: "en",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    // Normalized before delivery, so the number stored and messaged is E.164.
    const code = sms.lastCodeFor(phone);
    expect(code).toMatch(/^\d{6}$/);

    const verified = await verifyCode({
      challengeId: requested.value.challengeId,
      code: code ?? "",
      expectedChannel: "phone",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const [credential] = await db()
      .select()
      .from(phoneCredentials)
      .where(eq(phoneCredentials.phoneE164, phone));
    expect(credential?.userId).toBe(verified.value.userId);
  });
});
