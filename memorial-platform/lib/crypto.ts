import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Fixed salt for key derivation. Not a secret: HKDF's salt adds domain
 * separation, the entropy comes from SESSION_SECRET.
 */
const HKDF_SALT = "memorial-platform/v1";

const keyCache = new Map<string, Buffer>();

/**
 * Derives a purpose-specific key from the application secret.
 *
 * One secret is configured, but a session token hash and a one-time-code hash
 * must not share a key: a weakness in how one is used should not extend to the
 * other.
 */
export function deriveKey(secret: string, purpose: string): Buffer {
  const cacheKey = `${purpose}:${secret.length}:${secret.slice(0, 4)}`;
  const cached = keyCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const derived = Buffer.from(
    hkdfSync("sha256", secret, HKDF_SALT, purpose, 32),
  );
  keyCache.set(cacheKey, derived);
  return derived;
}

export function hmacHex(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

/** A URL-safe random token. Used for session and invitation tokens. */
export function randomTokenHex(byteLength = 32): string {
  return randomBytes(byteLength).toString("hex");
}

/**
 * Compares two hex digests without leaking, through timing, how much of the
 * value matched. Malformed input is rejected rather than throwing, so a
 * corrupt stored value fails the comparison instead of the request.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!HEX_64.test(a) || !HEX_64.test(b)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function isSha256Hex(value: string): boolean {
  return HEX_64.test(value);
}
