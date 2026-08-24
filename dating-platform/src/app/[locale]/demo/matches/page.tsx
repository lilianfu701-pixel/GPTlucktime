import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { MemberShell } from "@/components/datecn/member-shell";
import { ProfilePhoto } from "@/components/datecn/profile-photo";
import { resolveLocale } from "@/i18n/request";
import { getDemoHome } from "@/modules/demo/demo-service";

export default async function DemoMatchesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  const t = await getTranslations({ locale: resolvedLocale, namespace: "datecn.matches" });
  const home = getDemoHome(resolvedLocale);
  return <MemberShell active="matches" locale={routeLocale}>
    <header className="mb-7"><p className="text-sm font-bold uppercase tracking-[.2em] text-[var(--datecn-gold)]">{t("eyebrow")}</p><h1 className="mt-2 text-4xl font-bold">{t("title")}</h1><p className="mt-3 text-[var(--datecn-muted)]">{t("intro")}</p></header>
    <div className="grid gap-4 md:grid-cols-2">{home.matches.map((match) => {
      const profile = home.profiles.find((item) => item.id === match.profileId)!;
      return <article className="flex items-center gap-4 rounded-2xl bg-white p-4 ring-1 ring-[var(--datecn-ring)]" key={match.profileId}><ProfilePhoto className="h-20 w-20 shrink-0 rounded-2xl" name={profile.name} position={profile.spritePosition} /><div className="min-w-0 flex-1"><h2 className="text-xl font-bold">{profile.name}, {profile.age}</h2><p className="text-sm text-[var(--datecn-muted)]">{t("matched", { when: match.matchedAt })}</p><Link className="mt-2 inline-block text-sm font-bold text-[var(--datecn-wine)]" href={`/${routeLocale}/demo/messages?with=${profile.id}`}>{t("message")} <span aria-hidden>→</span></Link></div></article>;
    })}</div>
  </MemberShell>;
}
