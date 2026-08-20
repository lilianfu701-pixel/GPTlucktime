import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = "src/app/[locale]";
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? files(path) : entry.name.endsWith(".tsx") ? [path] : [];
});
describe("localized user-facing copy", () => {
  it("keeps visible app and admin copy behind next-intl translation keys", () => {
    const violations: string[] = [];
    for (const file of files(root)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?<!=)>\s*([A-Za-z][^<>{}\n]{2,})\s*</gu)) {
        const literal = match[1]!.trim();
        violations.push(`${file}: JSX text: ${literal}`);
      }
      for (const match of source.matchAll(/\b(?:aria-label|placeholder|title)="([A-Za-z][^"]+)"/gu)) {
        violations.push(`${file}: visible attribute: ${match[1]}`);
      }
      if (/\b(?:const\s+copy|const\s+text|const\s+labels|const\s+queueLabels)\s*=\s*\{/u.test(source)) {
        violations.push(`${file}: local copy dictionary`);
      }
      if (/locale\s*===\s*"zh"\s*\?/u.test(source)) violations.push(`${file}: locale ternary copy`);
      if (/\.status\.replaceAll\("_",\s*" "\)/u.test(source)) violations.push(`${file}: untranslated status`);
      if (/(["'>])Heartline(["'<])/u.test(source)) violations.push(`${file}: hard-coded brand`);
    }
    expect(violations).toEqual([]);
  });

  it("lets every localized page inherit the English fallback for unsupported locale segments", () => {
    const violations: string[] = [];
    for (const file of files(root).filter((path) => path.endsWith("page.tsx"))) {
      const source = readFileSync(file, "utf8");
      if (/isSupportedLocale\(locale\)[\s\S]{0,40}notFound\(/u.test(source)) violations.push(file);
      if (source.includes("getTranslations(") && !source.includes("locale: resolvedLocale")) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
