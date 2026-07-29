/**
 * Normalization of the two identifiers a person can sign in with.
 *
 * Both return a result rather than throwing: an unparseable identifier is an
 * ordinary outcome of user input, not an exceptional condition.
 */

export type NormalizeResult =
  | { ok: true; value: string }
  | { ok: false; error: "INVALID_EMAIL" | "INVALID_PHONE" };

/** Deliberately conservative: one @, no whitespace, a dotted domain. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** RFC 5321 caps the address at 254 octets. */
const EMAIL_MAX_LENGTH = 254;

/** E.164: a leading +, a non-zero first digit, 2 to 15 digits in total. */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * Lowercases and trims an address.
 *
 * Provider-specific rules are not applied. Gmail ignores dots and everything
 * after a `+`, but most providers do not; folding those universally would merge
 * two different people into one account.
 */
export function normalizeEmail(input: string): NormalizeResult {
  const value = input.trim().toLowerCase();

  if (value.length === 0 || value.length > EMAIL_MAX_LENGTH) {
    return { ok: false, error: "INVALID_EMAIL" };
  }

  if (!EMAIL_PATTERN.test(value)) {
    return { ok: false, error: "INVALID_EMAIL" };
  }

  return { ok: true, value };
}

/**
 * Reduces a typed phone number to E.164.
 *
 * Spaces, dashes and parentheses are formatting and are removed. A missing
 * international prefix is rejected rather than filled in from the server's
 * location: guessing a country would send someone else's phone a login code.
 */
export function normalizePhone(input: string): NormalizeResult {
  const value = input.replace(/[\s\-().]/g, "");

  if (!E164_PATTERN.test(value)) {
    return { ok: false, error: "INVALID_PHONE" };
  }

  return { ok: true, value };
}
