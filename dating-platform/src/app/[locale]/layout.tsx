import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";

import { FreeTestBanner } from "@/components/datecn/free-test-banner";
import { resolveLocale } from "@/i18n/request";
import { readEnv } from "@/shared/env";

import "../globals.css";

const htmlLocales = { en: "en", "zh-CN": "zh-CN" } as const;

export async function generateMetadata({ params }: Pick<LocaleLayoutProps, "params">): Promise<Metadata> {
  const { locale } = await params;
  const [t, brand] = await Promise.all([
    getTranslations({ locale: resolveLocale(locale), namespace: "metadata" }),
    getTranslations({ locale: resolveLocale(locale), namespace: "brand" }),
  ]);
  return { title: brand("name"), description: t("description") };
}

type LocaleLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const [messages, banner] = await Promise.all([
    getMessages({ locale: resolvedLocale }),
    getTranslations({ locale: resolvedLocale, namespace: "freeTestBanner" }),
  ]);
  const freeTestMode = readEnv(process.env).FREE_TEST_MODE === "1";

  return (
    <html lang={htmlLocales[resolvedLocale]}>
      <body>
        <NextIntlClientProvider messages={messages}>
          {freeTestMode ? (
            <FreeTestBanner>
              <strong className="font-semibold">{banner("title")}</strong>{" "}
              <span>{banner("body")}</span>
            </FreeTestBanner>
          ) : null}
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
