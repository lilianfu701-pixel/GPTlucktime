import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const controlToken = process.env.E2E_CONTROL_TOKEN ?? "local-acceptance-token-at-least-32-characters";
const email = "billing.member@example.test";
const password = "Correct-Horse-Battery-42";

async function control(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/api/e2e/control", {
    headers: { "x-e2e-token": controlToken }, data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Record<string, string>>;
}

async function latestDelivery(request: APIRequestContext, recipient: string, channel: "email" | "sms") {
  let delivery: Record<string, string> | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/e2e/control?recipient=${encodeURIComponent(recipient)}&channel=${channel}`, {
      headers: { "x-e2e-token": controlToken },
    });
    delivery = (await response.json() as { deliveries: Array<Record<string, string>> }).deliveries.at(-1);
    return delivery?.kind;
  }).toBe(channel === "email" ? "verification" : "otp");
  return delivery!;
}

async function registerBillingMember(page: Page, request: APIRequestContext) {
  await page.goto("/en/sign-in");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Display name").fill("Billing Member");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Date of birth").fill("1990-03-10");
  await page.getByLabel(/I confirm I am at least 18/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  const verification = await latestDelivery(request, email, "email");
  await page.goto(verification.verificationUrl);
  await page.goto("/en/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.locator('input[name="password"]').fill(password);
  const signIn = page.waitForResponse((response) => response.url().includes("/api/auth/sign-in/email"));
  await page.getByRole("button", { name: "Sign in" }).click();
  expect((await signIn).ok()).toBe(true);
  await page.goto("/en/onboarding");
  await expect(page.getByRole("button", { name: "Send SMS code" })).toBeEnabled();
  await page.getByLabel("Phone number").fill("+14155550200");
  await page.getByRole("button", { name: "Send SMS code" }).click();
  const sms = await latestDelivery(request, "+14155550200", "sms");
  await page.getByLabel("SMS verification code").fill(sms.code);
  await page.getByRole("button", { name: "Verify phone" }).click();
  await expect(page.getByText("Phone verified.")).toBeVisible();
  await page.getByLabel("Display name").fill("Billing Member");
  await page.getByLabel("Birth date").fill("1990-03-10");
  await page.getByLabel("Gender identity").fill("nonbinary");
  await page.getByLabel("Relationship goal").fill("long_term");
  await page.getByLabel("Country code").fill("US");
  await page.getByLabel("City").fill("Portland");
  await page.getByLabel("About you").fill("A verified local acceptance member for billing boundaries.");
  await page.getByLabel("Languages").fill("en");
  await page.getByLabel("Interests").fill("books, hiking");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  await control(request, { action: "seed-billing-identity", email });
}

test("local Stripe adapter activates, cancels, and fully refunds a real subscription", async ({ page, request }) => {
  test.setTimeout(120_000);
  await control(request, { action: "reset" });
  await registerBillingMember(page, request);

  await page.goto("/en/settings/membership");
  await expect(page.getByText("$12.99 / month")).toBeVisible();
  await page.getByRole("button", { name: "Choose Plus" }).click();
  await expect(page.getByRole("heading", { name: "Local Stripe test adapter" })).toBeVisible();
  await expect(page.getByText("This guarded localhost fixture does not connect to live Stripe.")).toBeVisible();
  const orderId = new URL(page.url()).searchParams.get("orderId");
  expect(orderId).toMatch(/^[0-9a-f-]{36}$/iu);
  await page.getByRole("button", { name: "Confirm local test checkout" }).click();
  await expect(page.getByRole("heading", { name: "Local test checkout confirmed" })).toBeVisible();
  await page.getByRole("link", { name: "Return to membership" }).click();
  await expect(page).toHaveURL(/\/en\/settings\/membership/u);
  await expect(page.getByText(/Plus · Active/u)).toBeVisible();

  const activeEntitlements = await page.request.get("/api/v1/me/entitlements");
  expect(activeEntitlements.ok(), await activeEntitlements.text()).toBe(true);
  expect((await activeEntitlements.json() as { entitlements: Array<{ key: string; allowed: boolean }> }).entitlements)
    .toEqual(expect.arrayContaining([expect.objectContaining({ key: "translation.message.use", allowed: true,
      limit: 25, remaining: 25 })]));

  await page.getByRole("button", { name: "Cancel renewal" }).click();
  await expect(page.getByText("Cancellation requested. Access remains until the confirmed period end.")).toBeVisible();
  await control(request, { action: "stripe-refund", orderId });
  await page.reload();
  await expect(page.getByText(/Plus · Expired/u)).toBeVisible();
  const refundedEntitlements = await page.request.get("/api/v1/me/entitlements");
  expect((await refundedEntitlements.json() as { entitlements: Array<{ key: string; allowed: boolean }> }).entitlements)
    .toEqual(expect.arrayContaining([expect.objectContaining({ key: "translation.message.use", allowed: false,
      limit: 0, remaining: 0 })]));
});
