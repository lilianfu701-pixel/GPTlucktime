import { describe, expect, it } from "vitest";
import {
  OTP_CODE_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  generateOtpCode,
  hashOtpCode,
  otpCodeMatches,
} from "@/modules/auth/otp";

const secret = "12345678901234567890123456789012";
const destination = "person@example.com";

describe("generateOtpCode", () => {
  it("produces a fixed-length numeric code", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateOtpCode();
      expect(code).toHaveLength(OTP_CODE_LENGTH);
      expect(code).toMatch(/^\d+$/);
    }
  });

  it("can produce codes with leading zeros", () => {
    // Returned as a string precisely so "004821" does not become 4821 and fail
    // to match what the recipient typed.
    const codes = Array.from({ length: 2000 }, () => generateOtpCode());
    expect(codes.some((code) => code.startsWith("0"))).toBe(true);
  });

  it("does not repeat itself in a short run", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateOtpCode()));
    expect(codes.size).toBeGreaterThan(150);
  });
});

describe("hashOtpCode", () => {
  it("never stores or returns the code itself", () => {
    const code = "123456";
    const hash = hashOtpCode({ code, destination, secret });
    expect(hash).not.toContain(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same code, destination and secret", () => {
    expect(hashOtpCode({ code: "123456", destination, secret })).toBe(
      hashOtpCode({ code: "123456", destination, secret }),
    );
  });

  it("binds the code to its destination", () => {
    // A code mailed to one address must not verify a challenge for another,
    // even if an attacker can read it.
    expect(hashOtpCode({ code: "123456", destination, secret })).not.toBe(
      hashOtpCode({ code: "123456", destination: "other@example.com", secret }),
    );
  });

  it("is keyed by the server secret, so a leaked database is not enough", () => {
    // Six digits is only a million possibilities. Without a server-held key an
    // attacker with the table could brute force every hash offline.
    expect(hashOtpCode({ code: "123456", destination, secret })).not.toBe(
      hashOtpCode({
        code: "123456",
        destination,
        secret: "99999999999999999999999999999999",
      }),
    );
  });

  it("distinguishes codes that differ by one digit", () => {
    expect(hashOtpCode({ code: "123456", destination, secret })).not.toBe(
      hashOtpCode({ code: "123457", destination, secret }),
    );
  });
});

describe("otpCodeMatches", () => {
  const storedHash = hashOtpCode({ code: "123456", destination, secret });

  it("accepts the correct code", () => {
    expect(
      otpCodeMatches({ code: "123456", destination, secret, storedHash }),
    ).toBe(true);
  });

  it("rejects a wrong code", () => {
    expect(
      otpCodeMatches({ code: "654321", destination, secret, storedHash }),
    ).toBe(false);
  });

  it("rejects the right code presented for the wrong destination", () => {
    expect(
      otpCodeMatches({
        code: "123456",
        destination: "other@example.com",
        secret,
        storedHash,
      }),
    ).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    expect(otpCodeMatches({ code: "", destination, secret, storedHash })).toBe(
      false,
    );
    expect(
      otpCodeMatches({ code: "12345", destination, secret, storedHash }),
    ).toBe(false);
    expect(
      otpCodeMatches({ code: "1234567", destination, secret, storedHash }),
    ).toBe(false);
    expect(
      otpCodeMatches({ code: "abcdef", destination, secret, storedHash }),
    ).toBe(false);
  });

  it("rejects a stored hash of the wrong shape without throwing", () => {
    expect(
      otpCodeMatches({ code: "123456", destination, secret, storedHash: "" }),
    ).toBe(false);
    expect(
      otpCodeMatches({
        code: "123456",
        destination,
        secret,
        storedHash: "not-a-hash",
      }),
    ).toBe(false);
  });
});

describe("challenge policy", () => {
  it("expires a code after ten minutes", () => {
    expect(OTP_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("locks the challenge on the sixth wrong attempt", () => {
    expect(OTP_MAX_ATTEMPTS).toBe(6);
  });
});
