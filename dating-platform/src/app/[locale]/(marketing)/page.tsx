import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ProfileCard } from "@/components/datecn/profile-card";
import { SiteHeader } from "@/components/datecn/site-header";
import { resolveLocale } from "@/i18n/request";
import { getDemoHome } from "@/modules/demo/demo-service";

export default async function MarketingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  const [t, brand, datecn] = await Promise.all([
    getTranslations({ locale: resolvedLocale, namespace: "datecn.home" }),
    getTranslations({ locale: resolvedLocale, namespace: "brand" }),
    getTranslations({ locale: resolvedLocale, namespace: "datecn" }),
  ]);
  const profiles = getDemoHome(resolvedLocale).profiles;
  const trust = ["trust1", "trust2", "trust3", "trust4"] as const;
  const steps = [["01", "step1Title", "step1Body"], ["02", "step2Title", "step2Body"], ["03", "step3Title", "step3Body"]] as const;

  return <main className="min-h-screen bg-[var(--datecn-cream)] text-[var(--datecn-ink)]">
    <SiteHeader labels={{ brand: brand("name"), language: datecn("language"), signIn: datecn("signIn") }} locale={routeLocale} />
    <section className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-12 sm:px-6 md:py-20 lg:grid-cols-[1.02fr_.98fr]">
      <div><p className="text-sm font-bold uppercase tracking-[.22em] text-[var(--datecn-gold)]">{t("eyebrow")}</p><h1 className="mt-5 max-w-3xl font-serif text-5xl font-bold leading-[1.04] tracking-tight sm:text-6xl xl:text-7xl">{t("title")}</h1><p className="mt-6 max-w-xl text-lg leading-8 text-[var(--datecn-muted)]">{t("description")}</p><div className="mt-8 flex flex-col gap-3 sm:flex-row"><Link className="datecn-primary-button" href={`/${routeLocale}/demo/discover`}>{t("explore")}</Link><Link className="datecn-ghost-button" href={`/${routeLocale}/sign-in`}>{t("join")}</Link></div></div>
      <div className="relative min-h-[390px] overflow-hidden rounded-[2rem] shadow-[0_30px_80px_rgba(75,31,39,.18)] sm:min-h-[520px]"><Image alt={t("heroAlt")} className="object-cover" fill fetchPriority="high" sizes="(min-width: 1024px) 48vw, 100vw" src="/demo/datecn-hero.png" /><div className="absolute inset-x-5 bottom-5 rounded-2xl bg-white/90 p-4 backdrop-blur"><p className="font-serif text-xl font-bold text-[var(--datecn-wine)]">{brand("name")}</p><p className="mt-1 text-sm text-[var(--datecn-muted)]">{t("legal")}</p></div></div>
    </section>
    <section aria-label={t("trustLabel")} className="border-y border-[var(--datecn-ring)] bg-white"><div className="mx-auto grid max-w-6xl grid-cols-2 gap-px sm:grid-cols-4">{trust.map((key) => <p className="px-4 py-5 text-center text-sm font-bold text-[var(--datecn-muted)]" key={key}>✓ {t(key)}</p>)}</div></section>
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-24"><p className="text-sm font-bold uppercase tracking-[.2em] text-[var(--datecn-gold)]">{t("previewEyebrow")}</p><div className="mt-3 flex items-end justify-between gap-6"><h2 className="max-w-2xl font-serif text-3xl font-bold sm:text-5xl">{t("previewTitle")}</h2><Link className="hidden font-bold text-[var(--datecn-wine)] sm:block" href={`/${routeLocale}/demo/discover`}>{t("explore")} →</Link></div><div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{profiles.slice(0, 4).map((profile) => <ProfileCard compact key={profile.id} locale={routeLocale} profile={profile} />)}</div></section>
    <section className="bg-[var(--datecn-wine-deep)] px-4 py-16 text-white sm:px-6 md:py-24"><div className="mx-auto max-w-6xl"><p className="text-sm font-bold uppercase tracking-[.2em] text-[var(--datecn-gold-on-dark)]">{t("howEyebrow")}</p><h2 className="mt-3 max-w-3xl font-serif text-3xl font-bold sm:text-5xl">{t("howTitle")}</h2><div className="mt-10 grid gap-5 md:grid-cols-3">{steps.map(([number, title, body]) => <article className="rounded-3xl bg-white/8 p-6 ring-1 ring-white/15" key={number}><span className="font-serif text-3xl text-[var(--datecn-gold-on-dark)]">{number}</span><h3 className="mt-8 text-xl font-bold">{t(title)}</h3><p className="mt-3 leading-7 text-white/70">{t(body)}</p></article>)}</div></div></section>
    <section className="mx-auto grid max-w-6xl gap-8 px-4 py-16 sm:px-6 md:grid-cols-2 md:py-24"><article className="rounded-3xl bg-white p-8 ring-1 ring-[var(--datecn-ring)]"><h2 className="font-serif text-3xl font-bold">{t("membershipTitle")}</h2><p className="mt-4 leading-7 text-[var(--datecn-muted)]">{t("membershipBody")}</p><Link className="datecn-primary-button mt-6 inline-flex" href={`/${routeLocale}/demo/membership`}>{t("viewPlans")}</Link></article><article className="rounded-3xl bg-[#f7e8e5] p-8"><h2 className="font-serif text-3xl font-bold text-[var(--datecn-wine)]">{t("safetyTitle")}</h2><p className="mt-4 leading-7 text-[var(--datecn-muted)]">{t("safetyBody")}</p></article></section>
    <footer className="border-t border-[var(--datecn-ring)] bg-white px-4 py-8"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-2 text-sm text-[var(--datecn-muted)] sm:flex-row"><strong className="text-[var(--datecn-wine)]">{t("footer")}</strong><span>{t("legal")}</span></div></footer>
  </main>;
}
