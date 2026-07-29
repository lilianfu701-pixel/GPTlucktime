import { describe, expect, it } from "vitest";
import {
  createOAuthState,
  decideAccountLink,
  validateOAuthState,
} from "@/modules/auth/providers/oauth";

describe("createOAuthState", () => {
  it("issues a distinct state and nonce", () => {
    const { state, nonce } = createOAuthState();
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(state).not.toBe(nonce);
  });

  it("does not repeat across calls", () => {
    const states = new Set(
      Array.from({ length: 50 }, () => createOAuthState().state),
    );
    expect(states.size).toBe(50);
  });
});

describe("validateOAuthState", () => {
  it("accepts the state it issued", () => {
    const { state } = createOAuthState();
    expect(validateOAuthState({ received: state, expected: state })).toEqual({
      ok: true,
      value: true,
    });
  });

  it("rejects a different state", () => {
    const a = createOAuthState().state;
    const b = createOAuthState().state;
    expect(validateOAuthState({ received: a, expected: b })).toEqual({
      ok: false,
      error: "OAUTH_STATE_MISMATCH",
    });
  });

  it("rejects a missing state on either side", () => {
    const { state } = createOAuthState();
    expect(validateOAuthState({ received: "", expected: state }).ok).toBe(false);
    expect(validateOAuthState({ received: state, expected: "" }).ok).toBe(false);
    expect(validateOAuthState({ received: "", expected: "" }).ok).toBe(false);
  });

  it("rejects a state that merely starts correctly", () => {
    const { state } = createOAuthState();
    expect(
      validateOAuthState({ received: state.slice(0, 32), expected: state }).ok,
    ).toBe(false);
    expect(
      validateOAuthState({ received: `${state}extra`, expected: state }).ok,
    ).toBe(false);
  });
});

describe("decideAccountLink", () => {
  it("signs in the account already bound to the provider subject", () => {
    // The subject is the durable key. An address change at the provider must not
    // move the person to a different account.
    expect(
      decideAccountLink({
        identityUserId: "user-1",
        emailOwnerUserId: "user-2",
        email: "person@example.com",
        emailVerified: true,
      }),
    ).toEqual({ kind: "sign_in_existing_identity", userId: "user-1" });
  });

  it("links a verified provider address to the account that holds it", () => {
    expect(
      decideAccountLink({
        identityUserId: null,
        emailOwnerUserId: "user-2",
        email: "person@example.com",
        emailVerified: true,
      }),
    ).toEqual({ kind: "link_existing_account", userId: "user-2" });
  });

  it("refuses to take over an account from an unverified provider address", () => {
    // The takeover this prevents: set an unverified address on a fresh social
    // account, sign in, and inherit someone else's memorials.
    expect(
      decideAccountLink({
        identityUserId: null,
        emailOwnerUserId: "user-2",
        email: "person@example.com",
        emailVerified: false,
      }),
    ).toEqual({ kind: "manual_link_required", email: "person@example.com" });
  });

  it("creates an account when nothing local matches", () => {
    expect(
      decideAccountLink({
        identityUserId: null,
        emailOwnerUserId: null,
        email: "new@example.com",
        emailVerified: true,
      }),
    ).toEqual({ kind: "create_account", email: "new@example.com" });
  });

  it("creates an account without recording an unverified address", () => {
    // Storing it would create a local credential the provider never vouched
    // for, and the next unverified sign-in would collide with it.
    expect(
      decideAccountLink({
        identityUserId: null,
        emailOwnerUserId: null,
        email: "unverified@example.com",
        emailVerified: false,
      }),
    ).toEqual({ kind: "create_account", email: null });
  });

  it("handles a provider that reports no address at all", () => {
    // Apple's Hide My Email, and Apple omits the address after first consent.
    expect(
      decideAccountLink({
        identityUserId: null,
        emailOwnerUserId: null,
        email: null,
        emailVerified: false,
      }),
    ).toEqual({ kind: "create_account", email: null });
  });

  it("still signs in an existing identity when no address is reported", () => {
    expect(
      decideAccountLink({
        identityUserId: "user-1",
        emailOwnerUserId: null,
        email: null,
        emailVerified: false,
      }),
    ).toEqual({ kind: "sign_in_existing_identity", userId: "user-1" });
  });
});
