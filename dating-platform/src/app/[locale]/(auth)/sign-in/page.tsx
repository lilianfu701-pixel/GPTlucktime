import Link from "next/link";
import { notFound } from "next/navigation";

import { isSupportedLocale } from "@/i18n/locales";

import SignInForm from "./sign-in-form";

export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const zh = locale === "zh";

  return (
    <main className="flex min-h-screen items-center justify-center bg-rose-50 px-6 py-16 text-stone-900">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-sm ring-1 ring-rose-100 sm:p-10">
        <Link className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700" href={`/${locale}`}>Heartline</Link>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight">{zh ? "欢迎回来" : "Welcome back"}</h1>
        <p className="mt-3 leading-7 text-stone-600">
          {zh ? "登录后继续完善个人资料，认识真诚的人。" : "Sign in to continue your profile and meet people with intention."}
        </p>
        <SignInForm locale={locale} />
        <Link className="mt-2 block text-center text-sm font-medium text-rose-800 hover:underline" href={`/${locale}`}>
          {zh ? "返回首页" : "Back to home"}
        </Link>
      </section>
    </main>
  );
}
