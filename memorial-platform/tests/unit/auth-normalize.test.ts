import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone } from "@/modules/auth/normalize";

describe("normalizeEmail", () => {
  it("lowercases and trims so one person is one account", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toEqual({
      ok: true,
      value: "person@example.com",
    });
  });

  it("rejects an address without a domain", () => {
    expect(normalizeEmail("person@").ok).toBe(false);
    expect(normalizeEmail("person").ok).toBe(false);
    expect(normalizeEmail("@example.com").ok).toBe(false);
  });

  it("rejects an empty or whitespace address", () => {
    expect(normalizeEmail("").ok).toBe(false);
    expect(normalizeEmail("   ").ok).toBe(false);
  });

  it("keeps the local part intact", () => {
    // Stripping dots or +tags is provider-specific. Applying Gmail's rules
    // universally would merge two genuinely different accounts elsewhere.
    expect(normalizeEmail("first.last+memorial@example.com")).toEqual({
      ok: true,
      value: "first.last+memorial@example.com",
    });
  });

  it("rejects an address containing a newline", () => {
    // Header injection into the outgoing mail.
    expect(normalizeEmail("person@example.com\nBcc: attacker@evil.test").ok).toBe(
      false,
    );
  });

  it("rejects an implausibly long address", () => {
    const long = `${"a".repeat(320)}@example.com`;
    expect(normalizeEmail(long).ok).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("accepts an E.164 number", () => {
    expect(normalizePhone("+14155550100")).toEqual({
      ok: true,
      value: "+14155550100",
    });
  });

  it("strips spaces, dashes and parentheses that people type", () => {
    expect(normalizePhone("+1 (415) 555-0100")).toEqual({
      ok: true,
      value: "+14155550100",
    });
    expect(normalizePhone("+86 138 0013 8000")).toEqual({
      ok: true,
      value: "+8613800138000",
    });
  });

  it("requires the international prefix rather than guessing a country", () => {
    // Assuming a country from the server's location would silently send a code
    // to a different person's number.
    expect(normalizePhone("4155550100").ok).toBe(false);
    expect(normalizePhone("04155550100").ok).toBe(false);
  });

  it("rejects a leading zero country code", () => {
    expect(normalizePhone("+04155550100").ok).toBe(false);
  });

  it("rejects a number that is too short or too long for E.164", () => {
    expect(normalizePhone("+1").ok).toBe(false);
    expect(normalizePhone(`+${"9".repeat(16)}`).ok).toBe(false);
  });

  it("rejects letters and injection characters", () => {
    expect(normalizePhone("+1415555010a").ok).toBe(false);
    expect(normalizePhone("+14155550100; DROP TABLE users").ok).toBe(false);
  });

  it("does not infer a region from the number", () => {
    // A calling code is not a region: +1 covers the US, Canada and more. The
    // region used for the availability check comes from the caller's explicit
    // selection, never from parsing digits.
    const result = normalizePhone("+14155550100");
    expect(Object.keys(result).sort()).toEqual(["ok", "value"]);
  });
});
