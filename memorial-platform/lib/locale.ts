/**
 * Locale policy.
 *
 * Interface language and content language are separate concerns: switching the
 * interface must never rewrite a person's name or the words a family wrote.
 * This module only decides the interface language.
 *
 * See docs/memorial-platform/07-i18n-accessibility-seo.md.
 */

export const SUPPORTED_LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "zh-HK",
  "es",
  "pt-BR",
  "pt-PT",
  "fr",
  "de",
  "ar",
  "ja",
  "ru",
  "id",
  "vi",
  "ko",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/**
 * The first release batch. These carry the product's acceptance criteria for
 * copy quality; the rest are shipped complete but still awaiting native review.
 */
export const LAUNCH_LOCALES: readonly Locale[] = ["en", "zh-CN", "es"];

export type LocaleReviewStatus = "reviewed" | "needs_native_review";

/**
 * Whether a catalog has been read by someone fluent in the language.
 *
 * Recorded honestly. Condolence language is easy to translate literally and
 * still get wrong: register, formality and the customs a phrase implies all
 * vary, and a mourning family is the worst audience to discover that with.
 */
const REVIEW_STATUS: Record<Locale, LocaleReviewStatus> = {
  en: "reviewed",
  "zh-CN": "reviewed",
  "zh-TW": "reviewed",
  "zh-HK": "needs_native_review",
  es: "needs_native_review",
  "pt-BR": "needs_native_review",
  "pt-PT": "needs_native_review",
  fr: "needs_native_review",
  de: "needs_native_review",
  ar: "needs_native_review",
  ja: "needs_native_review",
  ru: "needs_native_review",
  id: "needs_native_review",
  vi: "needs_native_review",
  ko: "needs_native_review",
};

export function localeReviewStatus(locale: Locale): LocaleReviewStatus {
  return REVIEW_STATUS[locale];
}

/** Arabic is the only right-to-left locale in the supported set. */
const RTL_LOCALES: ReadonlySet<string> = new Set(["ar"]);

export function textDirection(locale: Locale): "ltr" | "rtl" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Case-insensitive lookup of an exact tag, e.g. `ZH-cn` to `zh-CN`. */
const CANONICAL_BY_LOWER = new Map<string, Locale>(
  SUPPORTED_LOCALES.map((locale) => [locale.toLowerCase(), locale]),
);

/**
 * Regions and scripts we do not carry a catalog for, mapped to the closest one.
 *
 * Chinese needs care: Singapore writes Simplified, Macau writes Traditional in
 * the Hong Kong tradition, and bare `zh` most often means Simplified. Bare `pt`
 * is read as European Portuguese, since Brazil sends `pt-BR` explicitly.
 */
const EXPLICIT_FALLBACKS: Record<string, Locale> = {
  zh: "zh-CN",
  "zh-hans": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-my": "zh-CN",
  "zh-hant": "zh-TW",
  "zh-mo": "zh-HK",
  pt: "pt-PT",
};

/**
 * Reduces any tag to a locale we can serve.
 *
 * Never throws and never returns an unsupported value: the result is used to
 * build a URL path, so an unvetted string must not reach it.
 */
export function normalizeLocale(value: string): Locale {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return DEFAULT_LOCALE;
  }

  const exact = CANONICAL_BY_LOWER.get(trimmed);
  if (exact) {
    return exact;
  }

  const explicit = EXPLICIT_FALLBACKS[trimmed];
  if (explicit) {
    return explicit;
  }

  // `es-MX` to `es`, `fr-CA` to `fr`.
  const language = trimmed.split("-")[0] ?? "";
  const byLanguage = CANONICAL_BY_LOWER.get(language);
  if (byLanguage) {
    return byLanguage;
  }

  const explicitLanguage = EXPLICIT_FALLBACKS[language];
  if (explicitLanguage) {
    return explicitLanguage;
  }

  return DEFAULT_LOCALE;
}

type AcceptLanguageEntry = { tag: string; quality: number };

function parseAcceptLanguage(header: string): AcceptLanguageEntry[] {
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      if (!tag) {
        return null;
      }

      const qParam = params.find((param) => param.trim().startsWith("q="));
      const quality = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;

      // A malformed q is treated as absent rather than failing the request.
      return {
        tag: tag.trim(),
        quality: Number.isFinite(quality) ? quality : 1,
      };
    })
    .filter((entry): entry is AcceptLanguageEntry => entry !== null && entry.tag !== "")
    .sort((a, b) => b.quality - a.quality);
}

/**
 * Chooses the interface language for a request.
 *
 * An explicit choice always wins. Someone reading in Japanese on a machine
 * configured for French chose that for a reason, and a memorial is not a place
 * to second-guess it.
 */
export function negotiateLocale(input: {
  cookieLocale?: string | undefined;
  acceptLanguage?: string | undefined;
}): Locale {
  if (input.cookieLocale && isSupportedLocale(input.cookieLocale)) {
    return input.cookieLocale;
  }

  if (!input.acceptLanguage) {
    return DEFAULT_LOCALE;
  }

  for (const entry of parseAcceptLanguage(input.acceptLanguage)) {
    const lower = entry.tag.toLowerCase();
    const exact = CANONICAL_BY_LOWER.get(lower) ?? EXPLICIT_FALLBACKS[lower];
    if (exact) {
      return exact;
    }

    const language = lower.split("-")[0] ?? "";
    const byLanguage =
      CANONICAL_BY_LOWER.get(language) ?? EXPLICIT_FALLBACKS[language];
    if (byLanguage) {
      return byLanguage;
    }
  }

  return DEFAULT_LOCALE;
}
