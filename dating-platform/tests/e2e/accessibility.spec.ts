import { expect, test, type Page } from "@playwright/test";

const contrastRatio = async (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => {
  const parse = (value: string) => value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? [];
  const luminance = (value: string) => {
    const rgb = parse(value).map((channel) => channel / 255).map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  };
  const style = getComputedStyle(element);
  const foreground = luminance(style.color);
  const background = luminance(style.backgroundColor);
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
});

test.describe("targeted accessibility acceptance (not a comprehensive WCAG audit)", () => {
  test("keyboard navigation exposes semantic tabs and a visible focus indicator", async ({ page }) => {
    await page.goto("/en/sign-in");
    const signInTab = page.getByRole("tab", { name: "Sign in" });
    const registerTab = page.getByRole("tab", { name: "Create account" });
    await expect(page.getByRole("tablist")).toBeVisible();
    await expect(signInTab).toHaveAttribute("aria-selected", "true");
    await signInTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(registerTab).toBeFocused();
    await expect(registerTab).toHaveAttribute("aria-selected", "true");
    const focus = await registerTab.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
    });
    expect(focus.outlineStyle).not.toBe("none");
    expect(focus.outlineWidth).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("textbox", { name: "Display name" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  });

  test("adult-eligibility errors are programmatically associated with the invalid field", async ({ page }) => {
    await page.goto("/en/sign-in");
    await page.getByRole("tab", { name: "Create account" }).click();
    await page.getByLabel("Display name").fill("Keyboard Member");
    await page.getByLabel("Email address").fill("keyboard@example.test");
    await page.getByLabel("Password").fill("Correct-Horse-Battery-42");
    const birthDate = page.getByLabel("Date of birth");
    await birthDate.fill("2012-01-01");
    await page.getByLabel(/I confirm I am at least 18/).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("#register-error")).toHaveRole("alert");
    await expect(page.locator("#register-error")).toHaveText(/at least 18/u);
    await expect(birthDate).toHaveAttribute("aria-invalid", "true");
    await expect(birthDate).toHaveAttribute("aria-describedby", /register-error/u);
  });

  test("key controls meet contrast, reduced motion, and English/Chinese overflow checks", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const locale of ["en", "zh"] as const) {
      await page.goto(`/${locale}/sign-in`);
      const primary = page.locator(".datecn-primary-button");
      await expect(primary).toBeVisible();
      expect(await contrastRatio(page, ".datecn-primary-button")).toBeGreaterThanOrEqual(4.5);
      const durationMs = await primary.evaluate((element) => {
        const value = getComputedStyle(element).transitionDuration.split(",")[0]?.trim() ?? "0s";
        return value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000;
      });
      expect(durationMs).toBeLessThanOrEqual(0.01);
      const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth }));
      expect(overflow.document).toBeLessThanOrEqual(1);
      expect(overflow.body).toBeLessThanOrEqual(1);
    }
  });
});
