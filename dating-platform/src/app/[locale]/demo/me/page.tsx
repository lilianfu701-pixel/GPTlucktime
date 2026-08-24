import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { DemoActionButton } from "@/components/datecn/demo-action-button";
import { MeDemoActions } from "@/components/datecn/me-demo-actions";
import { MemberShell } from "@/components/datecn/member-shell";
import { resolveLocale } from "@/i18n/request";
import { getDemoHome } from "@/modules/demo/demo-service";

export default async function DemoMePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  const t = await getTranslations({ locale: resolvedLocale, namespace: "datecn.me" });
  const { currentUser } = getDemoHome(resolvedLocale);
  return <MemberShell active="me" locale={routeLocale}>
    <header className="mb-7"><p className="text-sm font-bold uppercase tracking-[.2em] text-[var(--datecn-gold)]">{t("eyebrow")}</p><h1 className="mt-2 text-4xl font-bold">{t("title")}</h1></header>
    <div className="grid gap-6 lg:grid-cols-[1.2fr_.8fr]"><article className="rounded-3xl bg-white p-6 ring-1 ring-[var(--datecn-ring)]"><div className="flex items-center justify-between"><h2 className="text-xl font-bold">{t("completion")}</h2><strong className="text-[var(--datecn-wine)]">{currentUser.completion}%</strong></div><div aria-label={`${currentUser.completion}%`} className="mt-3 h-3 overflow-hidden rounded-full bg-[var(--datecn-ring)]" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={currentUser.completion}><div className="h-full rounded-full bg-[var(--datecn-gold-soft)]" style={{ width: `${currentUser.completion}%` }} /></div><section className="mt-8 rounded-2xl bg-[var(--datecn-cream)] p-5"><p className="text-xs font-bold uppercase text-[var(--datecn-muted)]">{t("preview")}</p><h2 className="mt-2 text-3xl font-bold">{currentUser.name}, {currentUser.age}</h2><p className="text-[var(--datecn-muted)]">{currentUser.city}</p><p className="mt-4 leading-7">{currentUser.bio}</p><div className="mt-4 flex flex-wrap gap-2">{currentUser.interests.map((interest) => <span className="rounded-full bg-white px-3 py-1 text-sm" key={interest}>{interest}</span>)}</div></section><DemoActionButton className="datecn-ghost-button mt-5" label={t("edit")} notice={t("actionNotice", { action: t("edit") })} /></article><div className="space-y-5"><article className="rounded-3xl bg-[var(--datecn-wine)] p-6 text-white"><p className="text-sm text-white/75">{t("currentPlan")}</p><h2 className="mt-1 text-3xl font-bold">{currentUser.plan}</h2><Link className="mt-5 inline-flex rounded-full bg-white px-4 py-2 text-sm font-bold text-[var(--datecn-wine)]" href={`/${routeLocale}/demo/membership`}>{t("membership")}</Link></article><article className="rounded-3xl bg-white p-6 ring-1 ring-[var(--datecn-ring)]"><h2 className="text-xl font-bold">{t("settings")}</h2><MeDemoActions /></article></div></div>
  </MemberShell>;
}
