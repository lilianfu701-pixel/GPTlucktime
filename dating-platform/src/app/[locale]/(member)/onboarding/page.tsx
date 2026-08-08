import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { db } from "@/infrastructure/db/client";
import { isSupportedLocale } from "@/i18n/locales";
import { auth } from "@/modules/auth/auth";
import { profileMediaStore } from "@/modules/profiles/media-runtime";
import { safeUserPhoto } from "@/modules/profiles/media-service";
import { ProfileRepository } from "@/modules/profiles/profile-repository";

import OnboardingForm from "./onboarding-form";

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${locale}/sign-in`);
  const [initialProfile, persistedPhotos] = await Promise.all([
    new ProfileRepository(db).getForUser(session.user.id),
    profileMediaStore.listPhotosForUser(session.user.id),
  ]);
  const initialPhotos = persistedPhotos.map(safeUserPhoto);
  const zh = locale === "zh";

  return (
    <main className="min-h-screen bg-rose-50 text-stone-900">
      <header className="mx-auto max-w-6xl px-6 pb-8 pt-10 sm:pt-16">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">Heartline</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
          {zh ? "创建真正属于你的个人资料" : "Create a profile that feels like you"}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-stone-600">
          {zh
            ? "分享对你重要的事情。你的准确出生日期和隐私设置绝不会公开展示。"
            : "Share what matters to you. Your exact birth date and private settings are never shown publicly."}
        </p>
      </header>
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <OnboardingForm locale={locale} initialProfile={initialProfile} initialPhotos={initialPhotos} />
      </section>
    </main>
  );
}
