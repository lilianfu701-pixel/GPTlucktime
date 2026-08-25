import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

const controlToken = process.env.E2E_CONTROL_TOKEN ?? "local-acceptance-token-at-least-32-characters";
const password = "Correct-Horse-Battery-42";

export type E2eMember = { email: string; phone: string; name: string; birthDate: string; gender: string;
  context: BrowserContext; page: Page };

export async function control(request: APIRequestContext, body: Record<string, unknown>) {
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

export async function registerMember(browser: Browser, request: APIRequestContext,
  input: Omit<E2eMember, "context" | "page">) {
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
  const signIn = page.waitForResponse((response) => response.url().includes("/api/auth/sign-in/email"));
  await page.getByRole("button", { name: "Sign in" }).click();
  expect((await signIn).ok()).toBe(true);
  await page.goto("/en/onboarding");
  await expect(page.getByRole("button", { name: "Send SMS code" })).toBeEnabled();
  await page.getByLabel("Phone number").fill(input.phone);
  await page.getByRole("button", { name: "Send SMS code" }).click();
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
  await page.getByLabel("About you").fill(`${input.name} is a deterministic moderation acceptance member.`);
  await page.getByLabel("Languages").fill("en");
  await page.getByLabel("Interests").fill("books, hiking");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  await control(request, { action: "seed-photo", email: input.email });
  return { ...input, context, page };
}

export async function adminPage(browser: Browser, baseURL: string, adminCookie: string, path: string) {
  const context = await browser.newContext();
  await context.addCookies([{ name: "dating_platform_admin", value: adminCookie,
    domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}

export async function approvePhoto(browser: Browser, baseURL: string, adminCookie: string) {
  const admin = await adminPage(browser, baseURL, adminCookie, "/en/admin?queue=profile_media");
  const form = admin.page.locator("form").filter({ has: admin.page.getByRole("button", { name: "Approve photo" }) }).first();
  await form.getByLabel("Manual review reason").fill("E2E manual photo review");
  await form.getByRole("button", { name: "Approve photo" }).click();
  await expect(admin.page.getByText("Action recorded in the immutable audit timeline.")).toBeVisible();
  await admin.context.close();
}

export async function publishMember(member: E2eMember) {
  await member.page.reload();
  await expect(member.page.getByText("Approved and ready for your published profile")).toBeVisible();
  await member.page.getByLabel("Let my approved profile appear in discovery").check();
  await member.page.getByRole("button", { name: "Save and continue" }).click();
  await expect(member.page.getByText("Profile saved.")).toBeVisible();
}
