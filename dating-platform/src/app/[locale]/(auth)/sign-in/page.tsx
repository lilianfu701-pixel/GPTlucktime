import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/request";

import SignInForm from "./sign-in-form";

export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const [t, brand] = await Promise.all([
    getTranslations({ locale: resolvedLocale, namespace: "signIn" }),
    getTranslations({ locale: resolvedLocale, namespace: "brand" }),
  ]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-rose-50 px-6 py-16 text-stone-900">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-sm ring-1 ring-rose-100 sm:p-10">
        <Link className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700" href={`/${locale}`}>{brand("name")}</Link>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-3 leading-7 text-stone-600">{t("intro")}</p>
        <SignInForm locale={resolvedLocale === "zh-CN" ? "zh" : "en"} />
        <Link className="mt-2 block text-center text-sm font-medium text-rose-800 hover:underline" href={`/${locale}`}>
          {t("back")}
        </Link>
      </section>
    </main>
  );
}
