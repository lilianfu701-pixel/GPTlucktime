"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { authClient } from "@/modules/auth/client";

export default function SignInForm({ locale }: { locale: "en" | "zh" }) {
  const router = useRouter();
  const t = useTranslations("signIn");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    const data = new FormData(event.currentTarget);
    const result = await authClient.signIn.email({
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      callbackURL: `/${locale}/onboarding`,
    }).catch(() => null);
    if (!result || result.error) {
      setStatus("error");
      return;
    }
    router.push(`/${locale}/onboarding`);
    router.refresh();
  }

  return (
    <form className="mt-8 space-y-5" onSubmit={submit}>
      <label className="block text-sm font-semibold text-stone-800">
        {t("email")}
        <input className="mt-2 w-full rounded-2xl border border-rose-200 px-4 py-3 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200" name="email" type="email" autoComplete="email" required />
      </label>
      <label className="block text-sm font-semibold text-stone-800">
        {t("password")}
        <input className="mt-2 w-full rounded-2xl border border-rose-200 px-4 py-3 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200" name="password" type="password" autoComplete="current-password" required />
      </label>
      <button className="w-full rounded-full bg-rose-700 px-6 py-3 font-semibold text-white hover:bg-rose-800 disabled:cursor-wait disabled:opacity-60" disabled={status === "submitting"}>
        {status === "submitting" ? t("submitting") : t("submit")}
      </button>
      <p className="min-h-6 text-sm text-red-700" role="status" aria-live="polite">
        {status === "error" ? t("error") : null}
      </p>
    </form>
  );
}
