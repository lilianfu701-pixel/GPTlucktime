import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLocale } from "@/i18n/request";

const flatten = (value: unknown, prefix = ""): Record<string, string> => {
  if (typeof value === "string") return { [prefix]: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_MESSAGE:${prefix}`);
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) =>
    Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key))));
};

const placeholders = (message: string) => [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\s*(?:,[^}]*)?\}/gu)]
  .map((match) => match[1]).sort();

const icuCategories = (message: string) => {
  const signatures: string[] = [];
  for (const match of message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\s*,\s*(plural|selectordinal|select)\s*,/gu)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < message.length && depth > 0; end += 1) {
      if (message[end] === "{") depth += 1;
      else if (message[end] === "}") depth -= 1;
    }
    const categories = [...message.slice(start, end - 1).matchAll(/(?:^|\})\s*(=?[A-Za-z0-9_-]+)\s*\{/gu)]
      .map((category) => category[1]).sort();
    signatures.push(`${match[1]}:${match[2]}:${categories.join(",")}`);
  }
  return signatures.sort();
};

describe("locale messages", () => {
  const load = (locale: string) => flatten(JSON.parse(readFileSync(resolve(`messages/${locale}.json`), "utf8")));

  it("keeps English and Simplified Chinese keys and placeholders identical", () => {
    const en = load("en");
    const zh = load("zh-CN");
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(placeholders(zh[key]!)).toEqual(placeholders(en[key]!));
      expect(icuCategories(zh[key]!)).toEqual(icuCategories(en[key]!));
    }
  });

  it("uses a server-controlled supported locale with English fallback", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("zh")).toBe("zh-CN");
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });

  it("wires request dictionaries into the locale layout", () => {
    expect(readFileSync("next.config.ts", "utf8")).toContain("createNextIntlPlugin");
    expect(readFileSync("src/app/[locale]/layout.tsx", "utf8")).toContain("NextIntlClientProvider");
    const layout = readFileSync("src/app/[locale]/layout.tsx", "utf8");
    expect(layout).not.toContain("notFound");
    expect(layout).toContain("getMessages({ locale: resolvedLocale })");
    expect(layout).toContain('getTranslations({ locale: resolveLocale(locale), namespace: "brand" })');
  });
});
