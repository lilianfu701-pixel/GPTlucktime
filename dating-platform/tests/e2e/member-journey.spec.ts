import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

const controlToken = process.env.E2E_CONTROL_TOKEN ?? "local-acceptance-token-at-least-32-characters";
const password = "Correct-Horse-Battery-42";

type Member = {
  email: string;
  phone: string;
  name: string;
  birthDate: string;
  gender: string;
  context: BrowserContext;
  page: Page;
};

async function control(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/api/e2e/control", {
    headers: { "x-e2e-token": controlToken },
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Record<string, string>>;
}

async function realtimeControl(request: APIRequestContext, action: "start" | "stop" | "restart") {
  const port = process.env.E2E_REALTIME_CONTROL_PORT ?? "3101";
  const response = await request.post(`http://127.0.0.1:${port}/${action}`, {
    headers: { "x-e2e-token": controlToken },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function latestDelivery(request: APIRequestContext, recipient: string, channel: "email" | "sms") {
  let delivery: Record<string, string> | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/e2e/control?recipient=${encodeURIComponent(recipient)}&channel=${channel}`, {
      headers: { "x-e2e-token": controlToken },
    });
    const body = await response.json() as { deliveries: Array<Record<string, string>> };
    delivery = body.deliveries.at(-1);
    return delivery?.kind;
  }).toBe(channel === "email" ? "verification" : "otp");
  return delivery!;
}

async function registerAndComplete(browser: Browser, request: APIRequestContext, input: Omit<Member, "context" | "page">) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/en/sign-in");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Display name").fill(input.name);
  await page.getByLabel("Email address").fill(input.email);
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Date of birth").fill(input.birthDate);
  await page.getByLabel(/I confirm I am at least 18/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible({ timeout: 15_000 });

  const email = await latestDelivery(request, input.email, "email");
  await page.goto(email.verificationUrl);
  await page.goto("/en/sign-in");
  await page.getByLabel("Email address").fill(input.email);
  await page.locator('input[name="password"]').fill(password);
  const signInResponse = page.waitForResponse((response) => response.url().includes("/api/auth/sign-in/email"));
  await page.getByRole("button", { name: "Sign in" }).click();
  expect((await signInResponse).ok()).toBe(true);
  await page.goto("/en/onboarding");
  await expect(page.getByRole("heading", { name: /Create a profile/ })).toBeVisible();

  await expect(page.getByRole("button", { name: "Send SMS code" })).toBeEnabled();
  await page.getByLabel("Phone number").fill(input.phone);
  const otpResponse = page.waitForResponse((response) => response.url().includes("/phone-number/send-otp"));
  await page.getByRole("button", { name: "Send SMS code" }).click();
  const sentOtp = await otpResponse;
  expect(sentOtp.ok(), await sentOtp.text()).toBe(true);
  const sms = await latestDelivery(request, input.phone, "sms");
  await page.getByLabel("SMS verification code").fill(sms.code);
  await page.getByRole("button", { name: "Verify phone" }).click();
  await expect(page.getByText("Phone verified.")).toBeVisible();

  await page.getByLabel("Display name").fill(input.name);
  await page.getByLabel("Birth date").fill(input.birthDate);
  await page.getByLabel("Gender identity").fill(input.gender);
  await page.getByLabel("Relationship goal").fill("long_term");
  await page.getByLabel("Country code").fill("US");
  await page.getByLabel("City").fill("Seattle");
  await page.getByLabel("About you").fill(`${input.name} enjoys hiking, books, and thoughtful conversation.`);
  await page.getByLabel("Languages").fill("en");
  await page.getByLabel("Interests").fill("hiking, books");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  await control(request, { action: "seed-photo", email: input.email });
  return { ...input, context, page };
}

async function approveNextPhoto(browser: Browser, baseURL: string, adminCookie: string) {
  const context = await browser.newContext();
  await context.addCookies([{ name: "dating_platform_admin", value: adminCookie,
    domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto("/en/admin?queue=profile_media");
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Approve photo" }) }).first();
  await form.getByLabel("Manual review reason").fill("E2E manual adult profile photo review");
  await form.getByRole("button", { name: "Approve photo" }).click();
  await expect(page.getByText("Action recorded in the immutable audit timeline.")).toBeVisible();
  await context.close();
}

test("two verified adults match, recover a missed realtime message, and blocking denies interaction", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  expect(baseURL).toBeTruthy();
  const seeded = await control(request, { action: "reset" });
  const alex = await registerAndComplete(browser, request, {
    email: "alex.member@example.test", phone: "+14155550101", name: "Alex", birthDate: "1992-04-12", gender: "man",
  });
  const bailey = await registerAndComplete(browser, request, {
    email: "bailey.member@example.test", phone: "+14155550102", name: "Bailey", birthDate: "1994-09-08", gender: "woman",
  });

  await approveNextPhoto(browser, baseURL!, seeded.adminCookie);
  await approveNextPhoto(browser, baseURL!, seeded.adminCookie);
  for (const member of [alex, bailey]) {
    await member.page.reload();
    await expect(member.page.getByText("Approved and ready for your published profile")).toBeVisible();
    await member.page.getByLabel("Let my approved profile appear in discovery").check();
    await member.page.getByRole("button", { name: "Save and continue" }).click();
    await expect(member.page.getByText("Profile saved.")).toBeVisible();
  }

  await alex.page.goto("/en/discover");
  await alex.page.getByRole("button", { name: "Like Bailey" }).click();
  await expect(alex.page.getByText("You liked Bailey.")).toBeVisible();

  await bailey.page.goto("/en/discover");
  await bailey.page.getByRole("button", { name: "Like Alex" }).click();
  await expect(bailey.page.getByText("It’s a match with Alex!")).toBeVisible();
  await bailey.page.getByRole("button", { name: "Start conversation" }).click();
  await expect(bailey.page).toHaveURL(/\/en\/messages$/u);
  await expect(bailey.page.getByText("Online", { exact: true })).toBeVisible({ timeout: 15_000 });
  await bailey.page.getByPlaceholder("Write a message").fill("Hello Alex — this survived reconnect.");
  await bailey.page.getByRole("button", { name: "Send" }).click();
  await expect(bailey.page.getByText("Hello Alex — this survived reconnect.")).toBeVisible();

  await alex.page.goto("/en/messages");
  await expect(alex.page.getByText("Online", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(alex.page.getByText("Hello Alex — this survived reconnect.")).toBeVisible();

  await realtimeControl(request, "stop");
  await expect(alex.page.getByText("Reconnecting", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(bailey.page.getByText("Reconnecting", { exact: true })).toBeVisible({ timeout: 10_000 });
  const missedMessage = "Persisted while the realtime service was unavailable.";
  await bailey.page.getByPlaceholder("Write a message").fill(missedMessage);
  await bailey.page.getByRole("button", { name: "Send" }).click();
  await expect(bailey.page.getByText(missedMessage)).toBeVisible();
  await expect(alex.page.getByText(missedMessage)).toHaveCount(0);

  await realtimeControl(request, "restart");
  await expect(alex.page.getByText("Online", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(bailey.page.getByText("Online", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(alex.page.getByText(missedMessage)).toBeVisible({ timeout: 20_000 });
  const resumedMessage = "Realtime delivery resumed after recovery.";
  await alex.page.getByPlaceholder("Write a message").fill(resumedMessage);
  await alex.page.getByRole("button", { name: "Send" }).click();
  await expect(bailey.page.getByText(resumedMessage)).toBeVisible({ timeout: 15_000 });

  await bailey.page.goto("/en/discover");
  await bailey.page.getByRole("button", { name: "Block Alex" }).click();
  await expect(bailey.page.getByText("Alex is blocked. You can no longer interact.")).toBeVisible();
  await alex.page.getByPlaceholder("Write a message").fill("This must be denied.");
  await alex.page.getByRole("button", { name: "Send" }).click();
  await expect(alex.page.getByText("This conversation is no longer available.", { exact: true })).toBeVisible();

  await alex.context.close();
  await bailey.context.close();
});
