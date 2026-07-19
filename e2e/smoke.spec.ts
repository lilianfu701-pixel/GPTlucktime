import { expect, test } from "@playwright/test";

test("renders the birth-chart intake heading", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "命盘推演" })).toBeVisible();
});

async function fillBirthDetails(
  page: import("@playwright/test").Page,
  values: {
    date: string;
    time: string;
    name: string;
    latitude: string;
    longitude: string;
    timeZone: string;
  },
) {
  await page.getByLabel("出生日期").fill(values.date);
  await page.getByLabel("出生时间（可含秒）").fill(values.time);
  await page.getByLabel("出生地名称").fill(values.name);
  await page.getByLabel("出生地纬度").fill(values.latitude);
  await page.getByLabel("出生地经度").fill(values.longitude);
  await page.getByLabel("出生地 IANA 时区").fill(values.timeZone);
}

test("validates Shanghai details and navigates without putting them in the URL", async ({
  page,
}) => {
  await page.goto("/");
  await fillBirthDetails(page, {
    date: "1990-06-15",
    time: "14:30:45",
    name: "上海",
    latitude: "31.2304",
    longitude: "121.4737",
    timeZone: "Asia/Shanghai",
  });

  const submit = page.getByRole("button", { name: "校验时间并生成命盘" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/chart$/);
  await expect(page.getByRole("heading", { name: "四柱命盘" })).toBeVisible();
  await expect(page.getByRole("region", { name: "四柱", exact: true })).toContainText("年柱");
  await expect(page.getByRole("region", { name: "四柱", exact: true })).toContainText("日主");
  await expect(page.getByRole("region", { name: "时间核验" })).toContainText("真太阳时");

  await page.reload();
  await expect(page.getByRole("heading", { name: "本次会话没有出生资料" })).toBeVisible();
});

test("renders the generated workbench without horizontal overflow at 375px", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await fillBirthDetails(page, {
    date: "1990-06-15",
    time: "14:30:45",
    name: "上海",
    latitude: "31.2304",
    longitude: "121.4737",
    timeZone: "Asia/Shanghai",
  });
  await page.getByRole("button", { name: "校验时间并生成命盘" }).click();
  await expect(page.getByRole("heading", { name: "四柱命盘" })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await testInfo.attach("chart-workbench-375px", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

test("shows an accessible error for a New York DST gap", async ({ page }) => {
  await page.goto("/");
  await fillBirthDetails(page, {
    date: "2024-03-10",
    time: "02:30:00",
    name: "纽约",
    latitude: "40.7128",
    longitude: "-74.006",
    timeZone: "America/New_York",
  });

  await expect(page.getByText(/因夏令时切换而不存在/).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "校验时间并生成命盘" }),
  ).toBeDisabled();
  await expect(page).toHaveURL(/\/$/);
});
