import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/request";

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
  const messages = await getMessages({ locale: resolvedLocale });

  return (
    <html lang={htmlLocales[resolvedLocale]}>
      <body><NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider></body>
    </html>
  );
}
