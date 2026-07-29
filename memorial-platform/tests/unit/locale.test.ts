import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LAUNCH_LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  localeReviewStatus,
  negotiateLocale,
  normalizeLocale,
  textDirection,
} from "@/lib/locale";

describe("supported locales", () => {
  it("covers every release batch named in the language plan", () => {
    // docs/memorial-platform/07-i18n-accessibility-seo.md section 1.
    expect([...SUPPORTED_LOCALES].sort()).toEqual(
      [
        "ar",
        "de",
        "en",
        "es",
        "fr",
        "id",
        "ja",
        "ko",
        "pt-BR",
        "pt-PT",
        "ru",
        "vi",
        "zh-CN",
        "zh-HK",
        "zh-TW",
      ].sort(),
    );
  });

  it("keeps European and Brazilian Portuguese apart", () => {
    // The plan recognizes pt-PT but forbids presenting Brazilian copy as the
    // Portuguese version.
    expect(SUPPORTED_LOCALES).toContain("pt-BR");
    expect(SUPPORTED_LOCALES).toContain("pt-PT");
    expect(normalizeLocale("pt-PT")).toBe("pt-PT");
    expect(normalizeLocale("pt-BR")).toBe("pt-BR");
  });

  it("keeps the three Chinese locales apart", () => {
    // Traditional is not Simplified with substituted characters: funeral
    // vocabulary genuinely differs between the mainland, Taiwan and Hong Kong.
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-TW")).toBe("zh-TW");
    expect(normalizeLocale("zh-HK")).toBe("zh-HK");
  });

  it("defaults to English", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("names the launch batch as a subset of what is supported", () => {
    expect(LAUNCH_LOCALES).toEqual(["en", "zh-CN", "es"]);
    for (const locale of LAUNCH_LOCALES) {
      expect(SUPPORTED_LOCALES).toContain(locale);
    }
  });
});

describe("normalizeLocale", () => {
  it("accepts an exact match", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(normalizeLocale(locale)).toBe(locale);
    }
  });

  it("repairs casing from a browser header", () => {
    expect(normalizeLocale("ZH-cn")).toBe("zh-CN");
    expect(normalizeLocale("pt-br")).toBe("pt-BR");
    expect(normalizeLocale("EN")).toBe("en");
  });

  it("falls back from a region we do not carry to its language", () => {
    expect(normalizeLocale("es-MX")).toBe("es");
    expect(normalizeLocale("fr-CA")).toBe("fr");
    expect(normalizeLocale("de-AT")).toBe("de");
  });

  it("routes other Chinese regions to the closest script", () => {
    // Singapore writes Simplified; Macau writes Traditional as Hong Kong does.
    expect(normalizeLocale("zh-SG")).toBe("zh-CN");
    expect(normalizeLocale("zh-MO")).toBe("zh-HK");
    expect(normalizeLocale("zh-Hant")).toBe("zh-TW");
    expect(normalizeLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeLocale("zh")).toBe("zh-CN");
  });

  it("routes bare Portuguese to the European variant", () => {
    // `pt` alone most often means Portugal; Brazil sends pt-BR.
    expect(normalizeLocale("pt")).toBe("pt-PT");
  });

  it("falls back to English for anything unrecognized", () => {
    expect(normalizeLocale("xx")).toBe("en");
    expect(normalizeLocale("")).toBe("en");
    expect(normalizeLocale("klingon")).toBe("en");
    expect(normalizeLocale("../../etc/passwd")).toBe("en");
  });
});

describe("isSupportedLocale", () => {
  it("recognizes only exact supported tags", () => {
    expect(isSupportedLocale("zh-TW")).toBe(true);
    expect(isSupportedLocale("zh-SG")).toBe(false);
    expect(isSupportedLocale("EN")).toBe(false);
  });
});

describe("textDirection", () => {
  it("marks Arabic as right to left", () => {
    expect(textDirection("ar")).toBe("rtl");
  });

  it("marks every other supported locale as left to right", () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === "ar") continue;
      expect(textDirection(locale)).toBe("ltr");
    }
  });
});

describe("negotiateLocale", () => {
  it("prefers an explicit choice over anything the browser says", () => {
    // A person who picked a language must keep it, even on a device configured
    // for another one.
    expect(
      negotiateLocale({
        cookieLocale: "ja",
        acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.8",
      }),
    ).toBe("ja");
  });

  it("ignores a stored choice that is no longer supported", () => {
    expect(
      negotiateLocale({ cookieLocale: "xx", acceptLanguage: "de-DE,de;q=0.9" }),
    ).toBe("de");
  });

  it("reads the browser header in quality order", () => {
    expect(
      negotiateLocale({ acceptLanguage: "fr-CA,fr;q=0.9,en-US;q=0.8" }),
    ).toBe("fr");
    expect(
      negotiateLocale({ acceptLanguage: "en-US;q=0.5,ko-KR;q=0.9" }),
    ).toBe("ko");
  });

  it("skips languages it cannot serve and takes the next best", () => {
    expect(
      negotiateLocale({ acceptLanguage: "sw;q=1.0,vi;q=0.7,en;q=0.3" }),
    ).toBe("vi");
  });

  it("falls back to English when nothing is offered or usable", () => {
    expect(negotiateLocale({})).toBe("en");
    expect(negotiateLocale({ acceptLanguage: "" })).toBe("en");
    expect(negotiateLocale({ acceptLanguage: "sw,am,zu" })).toBe("en");
  });

  it("ignores a malformed header rather than failing the request", () => {
    expect(negotiateLocale({ acceptLanguage: ";;;q=" })).toBe("en");
    expect(negotiateLocale({ acceptLanguage: "en;q=notanumber" })).toBe("en");
  });
});

describe("localeReviewStatus", () => {
  it("does not claim native review for a catalog that has not had one", () => {
    // Marking every catalog reviewed would be a false claim, and on a
    // bereavement product the register matters more than the literal wording.
    const statuses = SUPPORTED_LOCALES.map((locale) => localeReviewStatus(locale));
    expect(statuses).toContain("needs_native_review");
  });

  it("reports a status for every supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(["reviewed", "needs_native_review"]).toContain(
        localeReviewStatus(locale),
      );
    }
  });
});
