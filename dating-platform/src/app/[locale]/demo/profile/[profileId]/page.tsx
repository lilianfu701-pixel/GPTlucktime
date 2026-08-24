import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { DemoActionButton } from "@/components/datecn/demo-action-button";
import { MemberShell } from "@/components/datecn/member-shell";
import { ProfilePhoto } from "@/components/datecn/profile-photo";
import { resolveLocale } from "@/i18n/request";
import { getDemoProfile } from "@/modules/demo/demo-service";

export default async function DemoProfilePage({ params }: { params: Promise<{ locale: string; profileId: string }> }) {
  const { locale, profileId } = await params;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  const profile = getDemoProfile(profileId, resolvedLocale);
  if (!profile) notFound();
  const [t, datecn] = await Promise.all([
    getTranslations({ locale: resolvedLocale, namespace: "datecn.profile" }),
    getTranslations({ locale: resolvedLocale, namespace: "datecn" }),
  ]);
  return <MemberShell active="discover" locale={routeLocale}>
    <Link className="text-sm font-bold text-[var(--datecn-wine)]" href={`/${routeLocale}/demo/discover`}>← {t("back")}</Link>
    <article className="mt-5 overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-[var(--datecn-ring)]"><div className="grid lg:grid-cols-[minmax(320px,44%)_1fr]"><ProfilePhoto className="min-h-[420px]" name={profile.name} position={profile.spritePosition} /><div className="p-6 sm:p-10"><div className="flex flex-wrap items-center gap-3"><h1 className="text-4xl font-bold">{profile.name}, {profile.age}</h1>{profile.verified && <span aria-label={datecn("verified")} className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-bold text-emerald-700">✓</span>}</div><p className="mt-2 text-[var(--datecn-muted)]">{profile.city}, {profile.country}</p><section className="mt-8"><h2 className="text-sm font-bold uppercase tracking-[.16em] text-[var(--datecn-gold)]">{t("about")}</h2><p className="mt-3 max-w-2xl leading-7 text-[var(--datecn-muted)]">{profile.bio}</p></section><dl className="mt-7 grid gap-4 sm:grid-cols-2"><div><dt className="text-xs font-bold uppercase text-[var(--datecn-muted)]">{t("work")}</dt><dd className="mt-1 font-semibold">{profile.occupation}</dd></div><div><dt className="text-xs font-bold uppercase text-[var(--datecn-muted)]">{t("goal")}</dt><dd className="mt-1 font-semibold">{profile.relationshipGoal}</dd></div></dl><section className="mt-7"><h2 className="text-xs font-bold uppercase text-[var(--datecn-muted)]">{t("interests")}</h2><div className="mt-3 flex flex-wrap gap-2">{profile.interests.map((interest) => <span className="rounded-full bg-[var(--datecn-cream)] px-3 py-2 text-sm" key={interest}>{interest}</span>)}</div></section><div className="mt-8 flex flex-col items-start gap-3 sm:flex-row"><Link className="datecn-primary-button" href={`/${routeLocale}/demo/messages?with=${profile.id}`}>{t("sayHello")}</Link><DemoActionButton label={t("save")} notice={t("demoAction")} /></div></div></div></article>
  </MemberShell>;
}
