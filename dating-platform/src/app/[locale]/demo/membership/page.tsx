import { getTranslations } from "next-intl/server";

import { MemberShell } from "@/components/datecn/member-shell";
import { MembershipDemo } from "@/components/datecn/membership-demo";
import { resolveLocale } from "@/i18n/request";
import { getDemoHome } from "@/modules/demo/demo-service";

export default async function DemoMembershipPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  const t = await getTranslations({ locale: resolvedLocale, namespace: "datecn.membership" });
  const home = getDemoHome(resolvedLocale);
  return <MemberShell active="membership" locale={routeLocale}><header className="mb-8 text-center"><p className="text-sm font-bold uppercase tracking-[.2em] text-[var(--datecn-gold)]">{t("eyebrow")}</p><h1 className="mx-auto mt-2 max-w-3xl text-4xl font-bold">{t("title")}</h1><p className="mx-auto mt-3 max-w-2xl text-[var(--datecn-muted)]">{t("intro")}</p></header><MembershipDemo plans={home.plans} /></MemberShell>;
}
