import { expect, test } from "@playwright/test";

/**
 * Phase one sells nothing.
 *
 * Doc 01 section 4.5 keeps a basic memorial and basic commemorations free
 * forever and shows no purchase entry, and doc 11 section 1 leaves the
 * operating company, the applicable law and the tax position undecided. A
 * checkout appearing before those answers exist would be a commitment nobody
 * has made.
 *
 * These checks cover both surfaces a purchase could appear on: the pages a
 * visitor sees, and the routes a client could call.
 */

const PAGES = ["/en", "/en/sign-in", "/zh-CN", "/es", "/ar"];

/**
 * Words that would indicate a purchase surface.
 *
 * "price" is deliberately absent: it appears inside ordinary words such as
 * "priceless", and a test that fires on prose rather than on a payment path
 * teaches people to ignore it.
 */
const PURCHASE_TERMS = [
  "checkout",
  "add to cart",
  "subscribe",
  "upgrade",
  "pricing",
  "billing",
  "payment",
  "credit card",
  "stripe",
  "paypal",
];

test.describe("no purchase surface", () => {
  for (const path of PAGES) {
    test(`${path} offers nothing to buy`, async ({ page }) => {
      await page.goto(path);
      const html = (await page.content()).toLowerCase();

      for (const term of PURCHASE_TERMS) {
        expect(html, `"${term}" found on ${path}`).not.toContain(term);
      }
    });
  }

  test("no page links to a payment route", async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path);
      const hrefs = await page
        .locator("a[href]")
        .evaluateAll((links) =>
          links.map((link) => link.getAttribute("href") ?? ""),
        );

      for (const href of hrefs) {
        expect(href.toLowerCase()).not.toMatch(
          /checkout|billing|payment|subscribe|pricing|upgrade/,
        );
      }
    }
  });
});

test.describe("no payment routes exist", () => {
  const routes = [
    "/api/checkout",
    "/api/orders",
    "/api/billing",
    "/api/payments",
    "/api/subscriptions",
  ];

  for (const route of routes) {
    test(`${route} is not served`, async ({ request }) => {
      const post = await request.post(route, { data: {} });
      // 404 or 405 both mean the route does not handle this. Anything in the
      // 2xx range would mean a payment path shipped.
      expect(post.status(), `${route} answered ${post.status()}`).toBeGreaterThanOrEqual(
        400,
      );

      const get = await request.get(route);
      expect(get.status()).toBeGreaterThanOrEqual(400);
    });
  }
});

test.describe("what is free stays free", () => {
  test("creating a memorial is not gated behind a plan", async ({ request }) => {
    // Unauthenticated, so the answer should be about signing in and nothing
    // else. A payment gate would show up here as a different refusal.
    const response = await request.post("/api/memorials", {
      headers: { "idempotency-key": "no-payment-check-1234" },
      data: {
        relationship: "child",
        relationshipStatementAccepted: true,
        primaryName: { value: "Test" },
      },
    });

    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });
});
