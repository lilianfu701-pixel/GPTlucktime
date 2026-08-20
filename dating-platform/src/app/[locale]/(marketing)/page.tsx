import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/request";

type MarketingPageProps = {
  params: Promise<{ locale: string }>;
};

export default async function MarketingPage({ params }: MarketingPageProps) {
  const { locale } = await params;

  const resolvedLocale = resolveLocale(locale);
  const [t, brand] = await Promise.all([
    getTranslations({ locale: resolvedLocale, namespace: "marketing" }),
    getTranslations({ locale: resolvedLocale, namespace: "brand" }),
  ]);
  const alternateLocale = resolvedLocale === "en" ? "zh" : "en";

  return (
    <main className="min-h-screen bg-rose-50 text-stone-900">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="text-xl font-semibold tracking-tight">{brand("name")}</span>
        <Link
          className="rounded-full border border-rose-200 bg-white px-4 py-2 text-sm font-medium hover:border-rose-300"
          href={`/${alternateLocale}`}
        >
          {t("language")}
        </Link>
      </nav>

      <section className="mx-auto flex max-w-6xl flex-col items-start px-6 py-24 sm:py-32">
        <p className="mb-5 text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">
          {t("eyebrow")}
        </p>
        <h1 className="max-w-4xl text-5xl font-semibold leading-tight tracking-tight sm:text-7xl">
          {t("title")}
        </h1>
        <p className="mt-8 max-w-2xl text-lg leading-8 text-stone-600">
          {t("description")}
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <a className="rounded-full bg-rose-700 px-6 py-3 font-semibold text-white hover:bg-rose-800" href="#join">
            {t("primary")}
          </a>
          <a className="rounded-full bg-white px-6 py-3 font-semibold text-stone-800 hover:bg-rose-100" href="#how-it-works">
            {t("secondary")}
          </a>
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-8 px-6 py-16">
        <h2 className="text-3xl font-semibold">
          {t("howTitle")}
        </h2>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-stone-600">
          {t("howDescription")}
        </p>
      </section>

      <section id="join" className="mx-auto max-w-6xl scroll-mt-8 px-6 py-16">
        <h2 className="text-3xl font-semibold">
          {t("joinTitle")}
        </h2>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-stone-600">
          {t("joinDescription")}
        </p>
      </section>
    </main>
  );
}
