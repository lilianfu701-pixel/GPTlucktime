import { expect, test } from "@playwright/test";

test("renders the birth-chart intake heading", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "命盘推演" })).toBeVisible();
});
