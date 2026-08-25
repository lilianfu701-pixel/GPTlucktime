import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh-CN.json";
import LocaleLayout from "../../../src/app/[locale]/layout";

vi.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("next-intl/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next-intl/server")>(),
  getMessages: vi.fn(async () => ({})),
  getTranslations: vi.fn(async ({ locale, namespace }: { locale: string; namespace: string }) =>
    (key: string) => `${locale}:${namespace}:${key}`),
}));

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const setServerEnv = (freeTestMode: boolean) => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://app:placeholder@localhost:5432/app");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("BETTER_AUTH_SECRET", "better-auth-placeholder-secret-at-least-32");
  vi.stubEnv("BETTER_AUTH_URL", "https://dating.example.test/api/auth");
  vi.stubEnv("APP_URL", "https://dating.example.test");
  vi.stubEnv("FREE_TEST_MODE", freeTestMode ? "1" : "");
  vi.stubEnv("FREE_TEST_ACCESS_SECRET", freeTestMode ? "free-test-placeholder-secret-at-least-32" : "");
};

describe("DateCN public presentation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("offers the original hero, demo, sign-in, trust, steps, and profile preview", () => {
    const source = read("src/app/[locale]/(marketing)/page.tsx");
    expect(source).toContain("/demo/datecn-hero.png");
    expect(source).toContain("/demo/discover");
    expect(source).toContain("/sign-in");
    expect(source).toContain("step1Title");
    expect(source).toContain("safetyTitle");
    expect(source).toContain("ProfileCard");
  });

  it("keeps authentication submission while adding demo and registration presentation", () => {
    const page = read("src/app/[locale]/(auth)/sign-in/page.tsx");
    const form = read("src/app/[locale]/(auth)/sign-in/sign-in-form.tsx");
    expect(page).toContain("/demo/discover");
    expect(form).toContain("authClient.signIn.email");
    expect(form).toContain("registerTab");
    expect(form).toContain("showPassword");
    expect(page).toContain("<h1 className=\"mt-6");
  });

  it("keeps profile verification accessible and message links contextual", () => {
    const profile = read("src/app/[locale]/demo/profile/[profileId]/page.tsx");
    const matches = read("src/app/[locale]/demo/matches/page.tsx");
    expect(profile).toContain("aria-label={datecn(\"verified\")}");
    expect(profile).toContain("?with=${profile.id}");
    expect(matches).toContain("?with=${profile.id}");
  });

  it("renders the public test banner from the server-only flag", async () => {
    setServerEnv(true);

    const markup = renderToStaticMarkup(await LocaleLayout({
      children: "Page content",
      params: Promise.resolve({ locale: "en" }),
    }));

    expect(markup).toContain('role="status"');
    expect(markup).toContain("en:freeTestBanner:title");
    expect(markup).not.toContain("free-test-placeholder-secret-at-least-32");
    expect(markup.indexOf('role="status"')).toBeLessThan(markup.indexOf("Page content"));
  });

  it("does not render the public test banner when free test mode is disabled", async () => {
    setServerEnv(false);

    const markup = renderToStaticMarkup(await LocaleLayout({
      children: "Page content",
      params: Promise.resolve({ locale: "en" }),
    }));

    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("freeTestBanner");
    expect(markup).toContain("Page content");
  });

  it("states all free public test facts in English and Simplified Chinese", () => {
    expect(enMessages.freeTestBanner).toEqual({
      title: "Free public test environment",
      body: "Use fictional/test data only. No real payments, emails, or SMS are sent.",
    });
    expect(zhMessages.freeTestBanner).toEqual({
      title: "免费公开测试环境",
      body: "请仅使用虚构/测试数据。不会产生真实付款，也不会发送真实电子邮件或短信。",
    });
  });
});
