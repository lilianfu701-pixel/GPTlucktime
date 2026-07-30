import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Accessibility, in every language the platform ships.
 *
 * Run in all fifteen locales rather than a representative sample, because the
 * failures this catches are the ones a sample would miss: a translated string
 * that turns out to be an empty accessible name, a locale whose text direction
 * is not applied, a name that overflows a control only in one script.
 *
 * The rule set is the WCAG 2.2 AA tags. Doc 07 sets that as the target, and a
 * memorial platform is used by people who are grieving, often elderly, often on
 * a phone in a hospital corridor.
 */

const LOCALES = [
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

const RTL_LOCALES = new Set(["ar"]);

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const PAGES = ["", "/sign-in"] as const;

for (const locale of LOCALES) {
  for (const path of PAGES) {
    test(`${locale}${path || "/"} has no accessibility violations`, async ({
      page,
    }) => {
      await page.goto(`/${locale}${path}`);

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .analyze();

      // Named in the failure output: "3 violations" tells whoever broke it
      // nothing about what to fix.
      const summary = results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.html.slice(0, 120)),
      }));

      expect(summary).toEqual([]);
    });
  }
}

test.describe("language and direction", () => {
  for (const locale of LOCALES) {
    test(`${locale} declares itself to a screen reader`, async ({ page }) => {
      // Without a correct lang, a screen reader pronounces the page with the
      // wrong voice — French read aloud in English is not merely awkward, it is
      // unintelligible.
      await page.goto(`/${locale}`);

      const lang = await page.locator("html").getAttribute("lang");
      expect(lang).toBe(locale);

      const dir = await page.locator("html").getAttribute("dir");
      expect(dir).toBe(RTL_LOCALES.has(locale) ? "rtl" : "ltr");
    });
  }
});

test.describe("structure", () => {
  for (const locale of ["en", "ar", "ja"] as const) {
    test(`${locale} has exactly one first-level heading`, async ({ page }) => {
      await page.goto(`/${locale}`);
      await expect(page.locator("h1")).toHaveCount(1);
    });

    test(`${locale} gives every form control a name`, async ({ page }) => {
      await page.goto(`/${locale}/sign-in`);

      const controls = page.locator("input, select, textarea");
      const count = await controls.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i += 1) {
        const control = controls.nth(i);
        const type = await control.getAttribute("type");
        if (type === "hidden") continue;

        // Any of the three is fine; none of them is not.
        const name =
          (await control.getAttribute("aria-label")) ??
          (await control.getAttribute("aria-labelledby")) ??
          (await control.getAttribute("id").then(async (id) =>
            id ? await page.locator(`label[for="${id}"]`).count() : 0,
          ));

        expect(name, `control ${i} on /${locale}/sign-in has no name`).toBeTruthy();
      }
    });
  }
});

test.describe("keyboard", () => {
  test("the first interactive element can be reached by tab", async ({ page }) => {
    // Somebody who cannot use a mouse must be able to start.
    await page.goto("/en/sign-in");
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.tagName.toLowerCase() : null;
    });

    expect(focused).not.toBe("body");
    expect(focused).not.toBeNull();
  });

  test("focus is visible where it lands", async ({ page }) => {
    // A focus ring removed for looks makes the keyboard path invisible.
    await page.goto("/en/sign-in");
    await page.keyboard.press("Tab");

    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });

    const hasIndicator =
      outline !== null &&
      ((outline.outlineStyle !== "none" && outline.outlineWidth !== "0px") ||
        (outline.boxShadow !== "none" && outline.boxShadow !== ""));

    expect(hasIndicator, `focus indicator missing: ${JSON.stringify(outline)}`).toBe(
      true,
    );
  });
});

test.describe("small screens", () => {
  for (const locale of ["en", "ar", "de"] as const) {
    test(`${locale} does not scroll sideways at 320px`, async ({ page }) => {
      // German compounds and Arabic shaping are where a fixed width shows up.
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`/${locale}`);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

      expect(overflow, `${overflow}px of horizontal overflow`).toBeLessThanOrEqual(1);
    });
  }
});
