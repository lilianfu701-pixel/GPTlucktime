import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { db } from "@/infrastructure/db/client";
import { resolveLocale } from "@/i18n/request";
import { auth } from "@/modules/auth/auth";
import { profileMediaStore } from "@/modules/profiles/media-runtime";
import { safeUserPhoto } from "@/modules/profiles/media-service";
import { ProfileRepository } from "@/modules/profiles/profile-repository";

import OnboardingForm from "./onboarding-form";

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${locale}/sign-in`);
  const [initialProfile, persistedPhotos] = await Promise.all([
    new ProfileRepository(db).getForUser(session.user.id),
    profileMediaStore.listPhotosForUser(session.user.id),
  ]);
  const initialPhotos = persistedPhotos.map(safeUserPhoto);
  const [t, brand] = await Promise.all([
    getTranslations({ locale: resolvedLocale, namespace: "onboarding" }),
    getTranslations({ locale: resolvedLocale, namespace: "brand" }),
  ]);

  return (
    <main className="min-h-screen bg-rose-50 text-stone-900">
      <header className="mx-auto max-w-6xl px-6 pb-8 pt-10 sm:pt-16">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">{brand("name")}</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
          {t("title")}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-stone-600">
          {t("intro")}
        </p>
      </header>
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <OnboardingForm initialProfile={initialProfile} initialPhotos={initialPhotos} />
      </section>
    </main>
  );
}
