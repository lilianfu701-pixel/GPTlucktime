import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { db } from "@/infrastructure/db/client";
import { resolveLocale } from "@/i18n/request";
import { auth } from "@/modules/auth/auth";
import { NotificationPreferencesRepository } from "@/modules/notifications/notification-preferences";

import { NotificationPreferencesForm } from "./preferences-form";

export default async function NotificationSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${locale}/sign-in`);
  const [preferences, t, brand] = await Promise.all([
    new NotificationPreferencesRepository(db).get(session.user.id),
    getTranslations({ locale: resolvedLocale, namespace: "notificationSettings" }),
    getTranslations({ locale: resolvedLocale, namespace: "brand" }),
  ]);
  return <main className="min-h-screen bg-rose-50 px-6 py-10 text-stone-900">
    <section className="mx-auto max-w-2xl rounded-3xl bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">{brand("name")}</p>
      <h1 className="mt-3 text-3xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-stone-600">{t("intro")}</p>
      <NotificationPreferencesForm initial={preferences} />
    </section>
  </main>;
}
