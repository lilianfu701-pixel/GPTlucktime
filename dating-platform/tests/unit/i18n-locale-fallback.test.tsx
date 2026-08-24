import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const translationCalls: Array<{ locale: string; namespace: string }> = [];
vi.mock("next-intl/server", () => ({
  getRequestConfig: (factory: unknown) => factory,
  getTranslations: async (input: { locale: string; namespace: string }) => {
    translationCalls.push(input);
    return (key: string) => `${input.namespace}.${key}`;
  },
}));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: { value?: number }) =>
    values?.value === undefined ? `${namespace}.${key}` : `${namespace}.${key}:${values.value}`,
}));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
  <a {...props}>{children}</a> }));

import MarketingPage from "@/app/[locale]/(marketing)/page";

describe("unsupported locale rendering", () => {
  it("renders /fr with the English server catalog instead of not-found", async () => {
    translationCalls.length = 0;
    const markup = renderToStaticMarkup(await MarketingPage({ params: Promise.resolve({ locale: "fr" }) }));
    expect(markup).toContain("datecn.home.title");
    expect(translationCalls).toEqual([{ locale: "en", namespace: "datecn.home" },
      { locale: "en", namespace: "brand" },
      { locale: "en", namespace: "datecn" }]);
  });
});
