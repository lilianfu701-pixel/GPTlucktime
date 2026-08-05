import { describe, expect, it } from "vitest";

import { isSupportedLocale, SUPPORTED_LOCALES } from "@/i18n/locales";

describe("isSupportedLocale", () => {
  it.each(["en", "zh"])("accepts %s", (locale) => {
    expect(isSupportedLocale(locale)).toBe(true);
  });

  it("rejects an unsupported locale", () => {
    expect(isSupportedLocale("fr")).toBe(false);
  });

  it("keeps the supported locale list explicit", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh"]);
  });
});
