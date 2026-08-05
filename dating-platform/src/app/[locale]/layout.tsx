import type { Metadata } from "next";

import "../globals.css";

export const metadata: Metadata = {
  title: "Heartline",
  description: "A welcoming place for meaningful international connections.",
};

type LocaleLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale } = await params;

  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"}>
      <body>{children}</body>
    </html>
  );
}
