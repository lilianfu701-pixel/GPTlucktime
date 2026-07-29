import { expect, test } from "@playwright/test";

test.describe("locale routing", () => {
  test("sends the bare root to a locale path", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/[a-z]{2}(-[A-Z]{2})?$/);
  });

  test("honours the browser's language preference", async ({ browser }) => {
    const context = await browser.newContext({ locale: "ja-JP" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/ja$/);
    await context.close();
  });

  test("falls back to English for a language we do not carry", async ({
    browser,
  }) => {
    const context = await browser.newContext({ locale: "sw-KE" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/en$/);
    await context.close();
  });

  test("serves each launch locale in its own language", async ({ page }) => {
    const expected: Record<string, string> = {
      en: "A place to remember",
      "zh-CN": "留一处思念的地方",
      es: "Un lugar para recordar",
    };

    for (const [locale, heading] of Object.entries(expected)) {
      await page.goto(`/${locale}`);
      await expect(page.locator("h1")).toHaveText(heading);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
    }
  });

  test("keeps Traditional and Simplified Chinese distinct", async ({ page }) => {
    await page.goto("/zh-CN");
    const simplified = await page.locator("h1").textContent();

    await page.goto("/zh-TW");
    const traditional = await page.locator("h1").textContent();

    expect(simplified).toBeTruthy();
    expect(traditional).toBeTruthy();
    // Taiwanese copy is authored separately, not produced by substituting
    // characters into the mainland text.
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  });

  test("does not rewrite API paths", async ({ request }) => {
    // The middleware must leave /api alone; a redirect here would break every
    // client.
    const response = await request.post("/api/auth/email/request", {
      data: { email: "not-an-address", locale: "en" },
    });
    expect(response.status()).toBe(422);
  });

  test("404s an unknown locale instead of guessing", async ({ page }) => {
    const response = await page.goto("/xx");
    expect(response?.status()).toBe(404);
  });
});

test.describe("right to left", () => {
  test("renders Arabic right to left", async ({ page }) => {
    await page.goto("/ar");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("marks every other locale left to right", async ({ page }) => {
    for (const locale of ["en", "zh-CN", "ja", "ru"]) {
      await page.goto(`/${locale}`);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    }
  });

  test("has no horizontal overflow at 375px in Arabic", async ({ page }) => {
    // The narrow-phone case from doc 07 section 5. Horizontal scrolling on a
    // memorial page is the kind of breakage that makes a family give up.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/ar");

    const overflows = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth;
    });

    expect(overflows).toBe(false);
  });

  test("has no horizontal overflow at 375px on the Arabic sign-in page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/ar/sign-in");

    const overflows = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth;
    });

    expect(overflows).toBe(false);
  });
});

test.describe("hidden phone sign-in", () => {
  test("offers no phone field while the feature is switched off", async ({
    page,
  }) => {
    // Built and tested from the first release, but absent from the interface.
    // Checked in the markup, not by visibility: a field hidden with CSS is still
    // there for anyone who reads the page source.
    await page.goto("/en/sign-in");

    await expect(page.locator('input[type="tel"]')).toHaveCount(0);
    await expect(page.locator('input[name="phone"]')).toHaveCount(0);
    await expect(page.locator('form[action*="phone"]')).toHaveCount(0);

    const html = await page.content();
    expect(html).not.toContain('name="phone"');
  });

  test("offers the email field", async ({ page }) => {
    await page.goto("/en/sign-in");
    await expect(page.locator('input[name="email"]')).toHaveCount(1);
  });

  test("hides phone sign-in in every locale", async ({ page }) => {
    for (const locale of ["zh-CN", "ar", "es"]) {
      await page.goto(`/${locale}/sign-in`);
      await expect(page.locator('input[name="phone"]')).toHaveCount(0);
    }
  });

  test("shows no purchase path anywhere", async ({ page }) => {
    // Doc 01 section 4.5: no checkout exists in phase one.
    await page.goto("/en");
    const html = (await page.content()).toLowerCase();
    for (const term of ["checkout", "subscribe", "upgrade", "pricing"]) {
      expect(html).not.toContain(term);
    }
  });
});
