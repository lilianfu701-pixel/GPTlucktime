import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/request";

import SignInForm from "./sign-in-form";

export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  const [t, auth, brand] = await Promise.all([
    getTranslations({ locale: resolvedLocale, namespace: "signIn" }),
    getTranslations({ locale: resolvedLocale, namespace: "datecn.auth" }),
    getTranslations({ locale: resolvedLocale, namespace: "brand" }),
  ]);
  return <main className="grid min-h-screen bg-[var(--datecn-cream)] text-[var(--datecn-ink)] lg:grid-cols-[.9fr_1.1fr]">
    <aside className="relative hidden overflow-hidden bg-[var(--datecn-wine-deep)] p-12 text-white lg:flex lg:flex-col lg:justify-between"><Link className="font-serif text-3xl font-bold" href={`/${routeLocale}`}>{brand("name")}</Link><div><p className="text-sm font-bold uppercase tracking-[.2em] text-[var(--datecn-gold-on-dark)]">{auth("eyebrow")}</p><h2 className="mt-5 max-w-xl font-serif text-5xl font-bold leading-tight">{auth("title")}</h2><p className="mt-5 max-w-lg leading-8 text-white/70">{auth("body")}</p></div><p className="text-sm text-white/60">{auth("trust")}</p></aside>
    <section className="flex items-center justify-center px-4 py-10 sm:px-8"><div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-[0_22px_70px_rgba(75,31,39,.12)] ring-1 ring-[var(--datecn-ring)] sm:p-10"><Link className="font-serif text-2xl font-bold text-[var(--datecn-wine)] lg:hidden" href={`/${routeLocale}`}>{brand("name")}</Link><h1 className="mt-6 text-4xl font-bold tracking-tight">{t("title")}</h1><p className="mt-3 leading-7 text-[var(--datecn-muted)]">{t("intro")}</p><SignInForm locale={routeLocale} /><div className="mt-4 text-center"><Link className="font-bold text-[var(--datecn-wine)] hover:underline" href={`/${routeLocale}/demo/discover`}>{auth("demo")} →</Link></div><p className="mt-7 text-center text-xs text-[var(--datecn-muted)] lg:hidden">{auth("trust")}</p></div></section>
  </main>;
}
