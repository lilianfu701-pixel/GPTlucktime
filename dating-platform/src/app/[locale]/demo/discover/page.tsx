import { getTranslations } from "next-intl/server";

import { DiscoverDemo } from "@/components/datecn/discover-demo";
import { MemberShell } from "@/components/datecn/member-shell";
import { resolveLocale } from "@/i18n/request";
import { getDemoHome } from "@/modules/demo/demo-service";

export default async function DemoDiscoverPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params; const resolvedLocale = resolveLocale(locale); const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en"; const t = await getTranslations({ locale: resolvedLocale, namespace: "datecn.discover" }); const home = getDemoHome(resolvedLocale);
  return <MemberShell active="discover" locale={routeLocale}><header className="mb-7"><p className="text-sm font-bold uppercase tracking-[.2em] text-[var(--datecn-gold)]">{t("eyebrow")}</p><h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{t("title")}</h1><p className="mt-3 max-w-2xl text-[var(--datecn-muted)]">{t("intro")}</p></header><DiscoverDemo locale={routeLocale} profiles={home.profiles} /></MemberShell>;
}
