import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@/lib/errors";
import { SUPPORTED_LOCALES } from "@/lib/locale";
import type { Locale } from "@/lib/locale";

const messagesDir = join(process.cwd(), "messages");

type Catalog = Record<string, unknown>;

function loadCatalog(locale: string): Catalog {
  return JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), "utf8")) as Catalog;
}

/** Flattens to dotted paths so two catalogs can be compared key by key. */
function flatten(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};

  if (typeof value === "string") {
    out[prefix] = value;
    return out;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      Object.assign(out, flatten(child, prefix ? `${prefix}.${key}` : key));
    }
  }

  return out;
}

/** ICU placeholders such as `{email}`. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)/g)].map((match) => match[1] ?? "").sort();
}

const catalogs = new Map<Locale, Record<string, string>>(
  SUPPORTED_LOCALES.map((locale) => [locale, flatten(loadCatalog(locale))]),
);

const referenceLocale: Locale = "en";
const reference = catalogs.get(referenceLocale);

if (!reference) {
  throw new Error("the English catalog is required as the reference");
}

const referenceKeys = Object.keys(reference).sort();

describe("catalog coverage", () => {
  it("ships a catalog for every supported locale", () => {
    const files = readdirSync(messagesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();

    expect(files).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it("has no catalog for a locale the router cannot serve", () => {
    // An orphaned catalog is a trap: it looks like the language is available.
    for (const file of readdirSync(messagesDir).filter((name) =>
      name.endsWith(".json"),
    )) {
      expect(SUPPORTED_LOCALES).toContain(file.replace(/\.json$/, ""));
    }
  });
});

describe("catalog key parity", () => {
  // A missing key does not fail loudly at runtime: it renders the key name, or
  // silently falls back to another language mid-sentence. The only reliable
  // guard is that every catalog carries exactly the same keys.
  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} carries exactly the reference key set`, () => {
      const catalog = catalogs.get(locale);
      expect(catalog).toBeDefined();
      const keys = Object.keys(catalog ?? {}).sort();

      const missing = referenceKeys.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !referenceKeys.includes(key));

      expect({ locale, missing, extra }).toEqual({
        locale,
        missing: [],
        extra: [],
      });
    });
  }
});

describe("catalog values", () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} has no empty or placeholder-only strings`, () => {
      const catalog = catalogs.get(locale) ?? {};
      const empty = Object.entries(catalog)
        .filter(([, value]) => value.trim().length === 0)
        .map(([key]) => key);

      expect({ locale, empty }).toEqual({ locale, empty: [] });
    });

    it(`${locale} keeps every ICU placeholder from the reference`, () => {
      // A dropped placeholder means the sentence silently loses the name,
      // address or date it was meant to carry.
      const catalog = catalogs.get(locale) ?? {};
      const mismatched: string[] = [];

      for (const [key, referenceText] of Object.entries(reference)) {
        const translated = catalog[key];
        if (translated === undefined) continue;
        if (
          placeholders(referenceText).join(",") !== placeholders(translated).join(",")
        ) {
          mismatched.push(key);
        }
      }

      expect({ locale, mismatched }).toEqual({ locale, mismatched: [] });
    });
  }
});

describe("error copy", () => {
  it("covers every published error code", () => {
    // The API answers with a stable code; the interface renders the copy for it.
    // A code with no copy would surface as a raw identifier to a grieving family.
    for (const code of ERROR_CODES) {
      expect(referenceKeys).toContain(`errors.${code}`);
    }
  });

  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} translates every error code`, () => {
      const catalog = catalogs.get(locale) ?? {};
      const untranslated = ERROR_CODES.filter(
        (code) => (catalog[`errors.${code}`] ?? "").trim().length === 0,
      );
      expect({ locale, untranslated }).toEqual({ locale, untranslated: [] });
    });
  }
});

describe("catalog encoding", () => {
  // A catalog edited by a tool that assumes a legacy Windows code page comes
  // back with its diacritics destroyed. The file still parses as JSON and every
  // key is still present, so key-parity checks pass and the damage ships.
  it("contains no replacement characters", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const raw = readFileSync(join(messagesDir, `${locale}.json`), "utf8");
      expect({ locale, corrupted: raw.includes("�") }).toEqual({
        locale,
        corrupted: false,
      });
    }
  });

  it("still contains the script each language is written in", () => {
    const expectedScript: Partial<Record<Locale, RegExp>> = {
      ar: /[؀-ۿ]/,
      ja: /[぀-ヿ]/,
      ko: /[가-힯]/,
      ru: /[Ѐ-ӿ]/,
      "zh-CN": /[一-鿿]/,
      "zh-TW": /[一-鿿]/,
      "zh-HK": /[一-鿿]/,
      // Vietnamese and the Latin-script European locales are the ones a code
      // page mix-up mangles most visibly, through their diacritics.
      vi: /[ăâđêôơư]/i,
      fr: /[éèêàçù]/i,
      de: /[äöüß]/i,
      es: /[áéíóúñ¿¡]/i,
      "pt-BR": /[ãõçáêó]/i,
      "pt-PT": /[ãõçáêó]/i,
    };

    for (const [locale, pattern] of Object.entries(expectedScript)) {
      const raw = readFileSync(join(messagesDir, `${locale}.json`), "utf8");
      expect({ locale, matches: pattern.test(raw) }).toEqual({
        locale,
        matches: true,
      });
    }
  });
});

describe("locale self-identification", () => {
  it("names each language in that language", () => {
    // The language picker must be readable by someone who cannot read the
    // current interface language.
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = catalogs.get(locale) ?? {};
      expect(catalog["meta.localeName"]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("gives each locale a distinct native name", () => {
    const names = SUPPORTED_LOCALES.map(
      (locale) => catalogs.get(locale)?.["meta.localeName"] ?? "",
    );
    expect(new Set(names).size).toBe(SUPPORTED_LOCALES.length);
  });
});
