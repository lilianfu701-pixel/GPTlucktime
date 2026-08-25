import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/request";
import { auth } from "@/modules/auth/auth";

import { AppealSettings } from "./appeal-settings";

export default async function AppealsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  if (!await auth.api.getSession({ headers: await headers() })) redirect(`/${routeLocale}/sign-in`);
  const t = await getTranslations({ locale: resolvedLocale, namespace: "appealSettings" });
  return <main className="min-h-screen bg-rose-50 px-4 py-10 text-stone-900"><section className="mx-auto max-w-3xl rounded-3xl bg-white p-6 shadow-sm sm:p-9">
    <Link className="text-sm font-bold text-rose-800" href={`/${routeLocale}/discover`}>← {t("back")}</Link>
    <h1 className="mt-6 text-4xl font-semibold tracking-tight">{t("title")}</h1><p className="mt-3 text-stone-600">{t("intro")}</p>
    <AppealSettings />
  </section></main>;
}
