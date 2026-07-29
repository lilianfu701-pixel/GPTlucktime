import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { emailCredentials, phoneCredentials, users } from "@/db/schema";
import { flags, phoneAuthAllowedForRegion } from "@/lib/feature-flags";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { normalizeEmail, normalizePhone } from "./normalize";
import { createChallenge, verifyChallenge } from "./otp-store";
import type { VerifyChallengeError } from "./otp-store";
import { emailProvider } from "./providers/email";
import { smsProvider } from "./providers/sms";
import { createSession } from "./sessions";

export type RequestCodeError =
  | "INVALID_EMAIL"
  | "INVALID_PHONE"
  | "FEATURE_DISABLED";

export type VerifyCodeError = VerifyChallengeError | "CHANNEL_MISMATCH";

/**
 * Starts an email sign-in.
 *
 * Returns the challenge identifier whether or not the address belongs to an
 * existing account. The route turns this into an unconditional 202: telling a
 * caller that an address is unknown would turn sign-in into an account
 * enumeration tool. See 04-api-contracts.md section 3.
 */
export async function requestEmailCode(input: {
  email: string;
  locale: string;
  requestIpHash?: string | undefined;
}): Promise<Result<{ challengeId: string }, RequestCodeError>> {
  const normalized = normalizeEmail(input.email);
  if (!normalized.ok) {
    return err("INVALID_EMAIL");
  }

  const { challengeId, code } = await createChallenge({
    channel: "email",
    destination: normalized.value,
    requestIpHash: input.requestIpHash,
  });

  await emailProvider().sendLoginCode({
    to: normalized.value,
    code,
    locale: input.locale,
  });

  return ok({ challengeId });
}

/**
 * Starts a phone sign-in.
 *
 * Fully implemented and tested, but gated: phase one keeps the interface hidden,
 * and the region must be on the allow list even once the switch is on.
 */
export async function requestPhoneCode(input: {
  phone: string;
  region: string;
  locale: string;
  requestIpHash?: string | undefined;
}): Promise<Result<{ challengeId: string }, RequestCodeError>> {
  if (!phoneAuthAllowedForRegion(flags(), input.region)) {
    return err("FEATURE_DISABLED");
  }

  const normalized = normalizePhone(input.phone);
  if (!normalized.ok) {
    return err("INVALID_PHONE");
  }

  const { challengeId, code } = await createChallenge({
    channel: "phone",
    destination: normalized.value,
    requestIpHash: input.requestIpHash,
  });

  await smsProvider().sendLoginCode({
    toE164: normalized.value,
    code,
    locale: input.locale,
  });

  return ok({ challengeId });
}

/**
 * Completes a sign-in.
 *
 * Finding or creating the account, recording the verified credential and
 * issuing the session happen in one transaction, so a failure cannot leave a
 * verified challenge with no account behind it.
 */
export async function verifyCode(input: {
  challengeId: string;
  code: string;
  expectedChannel: "email" | "phone";
  locale?: string | undefined;
  requestIpHash?: string | undefined;
  userAgent?: string | undefined;
}): Promise<
  Result<{ userId: string; token: string; expiresAt: Date }, VerifyCodeError>
> {
  const verified = await verifyChallenge({
    challengeId: input.challengeId,
    code: input.code,
    requestIpHash: input.requestIpHash,
  });

  if (!verified.ok) {
    return err(verified.error);
  }

  // A code issued for a phone must not complete an email sign-in.
  if (verified.value.channel !== input.expectedChannel) {
    return err("CHANNEL_MISMATCH");
  }

  const { channel, destination } = verified.value;
  const userId =
    channel === "email"
      ? await findOrCreateUserByEmail(destination, input.locale)
      : await findOrCreateUserByPhone(destination, input.locale);

  const session = await createSession({
    userId,
    ipHash: input.requestIpHash,
    userAgent: input.userAgent,
  });

  return ok({
    userId,
    token: session.token,
    expiresAt: session.expiresAt,
  });
}

async function findOrCreateUserByEmail(
  email: string,
  locale: string | undefined,
): Promise<string> {
  return db().transaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: emailCredentials.userId })
      .from(emailCredentials)
      .where(eq(emailCredentials.email, email));

    if (existing) {
      // Completing a code proves control of the address.
      await tx
        .update(emailCredentials)
        .set({ verifiedAt: new Date() })
        .where(eq(emailCredentials.email, email));
      return existing.userId;
    }

    const [user] = await tx
      .insert(users)
      .values({ preferredLocale: locale ?? "en" })
      .returning({ id: users.id });

    if (!user) {
      throw new Error("user insert returned no row");
    }

    await tx
      .insert(emailCredentials)
      .values({ userId: user.id, email, verifiedAt: new Date() });

    return user.id;
  });
}

async function findOrCreateUserByPhone(
  phoneE164: string,
  locale: string | undefined,
): Promise<string> {
  return db().transaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: phoneCredentials.userId })
      .from(phoneCredentials)
      .where(eq(phoneCredentials.phoneE164, phoneE164));

    if (existing) {
      await tx
        .update(phoneCredentials)
        .set({ verifiedAt: new Date() })
        .where(eq(phoneCredentials.phoneE164, phoneE164));
      return existing.userId;
    }

    const [user] = await tx
      .insert(users)
      .values({ preferredLocale: locale ?? "en" })
      .returning({ id: users.id });

    if (!user) {
      throw new Error("user insert returned no row");
    }

    await tx
      .insert(phoneCredentials)
      .values({ userId: user.id, phoneE164, verifiedAt: new Date() });

    return user.id;
  });
}
