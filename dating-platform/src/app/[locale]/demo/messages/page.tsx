import { getTranslations } from "next-intl/server";

import { MemberShell } from "@/components/datecn/member-shell";
import { resolveLocale } from "@/i18n/request";
import { getDemoConversationContext, getDemoHome } from "@/modules/demo/demo-service";

import MessagesDemo from "./messages-demo";

export default async function DemoMessagesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ with?: string | string[] }> }) {
  const { locale } = await params;
  const query = await searchParams;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  const t = await getTranslations({ locale: resolvedLocale, namespace: "datecn.messages" });
  const home = getDemoHome(resolvedLocale);
  const requestedProfileId = Array.isArray(query.with) ? query.with[0] : query.with;
  const context = getDemoConversationContext(requestedProfileId, resolvedLocale);
  return <MemberShell active="messages" locale={routeLocale}><header className="mb-7"><p className="text-sm font-bold uppercase tracking-[.2em] text-[var(--datecn-gold)]">{t("eyebrow")}</p><h1 className="mt-2 text-4xl font-bold">{t("title")}</h1></header><MessagesDemo conversations={home.conversations} initialProfileId={context.profile.id} profiles={home.profiles} /></MemberShell>;
}
