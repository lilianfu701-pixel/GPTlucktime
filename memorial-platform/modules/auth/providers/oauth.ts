import { timingSafeEqual } from "node:crypto";
import { randomTokenHex } from "@/lib/crypto";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";

export type SocialProvider = "google" | "apple";

/**
 * The adapter a concrete provider implements. Kept narrow so tests can supply a
 * fake without a network round trip.
 */
export interface OAuthProvider {
  readonly id: SocialProvider;
  createAuthorizationUrl(input: {
    state: string;
    nonce: string;
    locale: string;
  }): URL;
  verifyCallback(input: {
    code: string;
    state: string;
    expectedState: string;
    nonce: string;
  }): Promise<{
    providerSubject: string;
    email: string | null;
    emailVerified: boolean;
  }>;
}

export type OAuthStateError = "OAUTH_STATE_MISMATCH";

export function createOAuthState(): { state: string; nonce: string } {
  return { state: randomTokenHex(32), nonce: randomTokenHex(32) };
}

/**
 * Compares the state echoed by the provider with the one this browser was
 * issued. Guards the authorization code against being planted by a third party.
 */
export function validateOAuthState(input: {
  received: string;
  expected: string;
}): Result<true, OAuthStateError> {
  const received = Buffer.from(input.received, "utf8");
  const expected = Buffer.from(input.expected, "utf8");

  if (
    expected.length === 0 ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return err("OAUTH_STATE_MISMATCH");
  }

  return ok(true);
}

/**
 * What to do with a social sign-in, given what already exists locally.
 *
 * `link_existing_account` attaches the social identity to an account the person
 * already has. `manual_link_required` means we recognized the address but will
 * not act on it: the provider did not vouch for it, so treating it as proof of
 * ownership would let anyone who can set that address on a social account take
 * over the memorial account behind it.
 */
export type AccountLinkDecision =
  | { kind: "sign_in_existing_identity"; userId: string }
  | { kind: "link_existing_account"; userId: string }
  | { kind: "manual_link_required"; email: string }
  | { kind: "create_account"; email: string | null };

export function decideAccountLink(input: {
  /** The account already bound to this provider subject, if any. */
  identityUserId: string | null;
  /** An account holding the same verified address locally, if any. */
  emailOwnerUserId: string | null;
  email: string | null;
  emailVerified: boolean;
}): AccountLinkDecision {
  // The provider subject is the durable key, so an existing binding always wins.
  if (input.identityUserId) {
    return { kind: "sign_in_existing_identity", userId: input.identityUserId };
  }

  if (input.emailOwnerUserId && input.email) {
    if (input.emailVerified) {
      return { kind: "link_existing_account", userId: input.emailOwnerUserId };
    }
    return { kind: "manual_link_required", email: input.email };
  }

  return { kind: "create_account", email: input.emailVerified ? input.email : null };
}
