import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/request";
import { auth } from "@/modules/auth/auth";

import { MembershipSettings } from "./membership-settings";

export default async function MembershipSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const routeLocale = resolvedLocale === "zh-CN" ? "zh" : "en";
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${routeLocale}/sign-in`);
  const [t, brand] = await Promise.all([
    getTranslations({ locale: resolvedLocale, namespace: "membershipSettings" }),
    getTranslations({ locale: resolvedLocale, namespace: "brand" }),
  ]);
  return <main className="min-h-screen bg-rose-50 px-4 py-10 text-stone-900 sm:px-6">
    <section className="mx-auto max-w-4xl rounded-3xl bg-white p-6 shadow-sm sm:p-9">
      <Link className="text-sm font-bold text-rose-800" href={`/${routeLocale}/discover`}>← {t("back")}</Link>
      <p className="mt-6 text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">{brand("name")}</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-3 max-w-2xl text-stone-600">{t("intro")}</p>
      <MembershipSettings locale={routeLocale} />
    </section>
  </main>;
}
