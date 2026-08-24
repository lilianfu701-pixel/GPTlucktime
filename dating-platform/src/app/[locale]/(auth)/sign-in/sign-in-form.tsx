"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type FormEvent, type KeyboardEvent } from "react";

import { authClient } from "@/modules/auth/client";

type AuthTab = "sign-in" | "register";

export default function SignInForm({ locale }: { locale: "en" | "zh" }) {
  const router = useRouter();
  const t = useTranslations("signIn");
  const auth = useTranslations("datecn.auth");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [showPassword, setShowPassword] = useState(false);
  const [tab, setTab] = useState<AuthTab>("sign-in");

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

  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextTab: AuthTab = tab === "sign-in" ? "register" : "sign-in";
    setTab(nextTab);
    document.getElementById(nextTab === "sign-in" ? "datecn-sign-in-tab" : "datecn-register-tab")?.focus();
  }

  return <div className="mt-8">
    <div aria-label={auth("eyebrow")} className="grid grid-cols-2 rounded-full bg-[var(--datecn-cream)] p-1" onKeyDown={moveTab} role="tablist">
      <button aria-controls="datecn-sign-in-panel" aria-selected={tab === "sign-in"} className={`rounded-full px-4 py-2 text-sm font-bold ${tab === "sign-in" ? "bg-white text-[var(--datecn-wine)] shadow-sm" : "text-[var(--datecn-muted)]"}`} id="datecn-sign-in-tab" onClick={() => setTab("sign-in")} role="tab" tabIndex={tab === "sign-in" ? 0 : -1} type="button">{auth("signInTab")}</button>
      <button aria-controls="datecn-register-panel" aria-selected={tab === "register"} className={`rounded-full px-4 py-2 text-sm font-bold ${tab === "register" ? "bg-white text-[var(--datecn-wine)] shadow-sm" : "text-[var(--datecn-muted)]"}`} id="datecn-register-tab" onClick={() => setTab("register")} role="tab" tabIndex={tab === "register" ? 0 : -1} type="button">{auth("registerTab")}</button>
    </div>

    {tab === "sign-in" ? <form aria-labelledby="datecn-sign-in-tab" className="mt-6 space-y-5" id="datecn-sign-in-panel" onSubmit={submit} role="tabpanel">
      <label className="block text-sm font-semibold text-stone-800">{t("email")}<input className="mt-2 w-full rounded-2xl border border-rose-200 px-4 py-3 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200" name="email" type="email" autoComplete="email" required /></label>
      <label className="block text-sm font-semibold text-stone-800">{t("password")}<span className="relative mt-2 block"><input className="w-full rounded-2xl border border-rose-200 px-4 py-3 pr-20 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required /><button aria-label={showPassword ? auth("hidePassword") : auth("showPassword")} className="absolute inset-y-0 right-3 text-xs font-bold text-[var(--datecn-wine)]" onClick={() => setShowPassword((value) => !value)} type="button">{showPassword ? auth("hidePassword") : auth("showPassword")}</button></span></label>
      <button className="datecn-primary-button w-full disabled:cursor-wait disabled:opacity-60" disabled={status === "submitting"}>{status === "submitting" ? t("submitting") : t("submit")}</button>
      <p aria-live="polite" className="min-h-6 text-sm text-red-700" role="status">{status === "error" ? t("error") : null}</p>
    </form> : <section aria-labelledby="datecn-register-tab" className="mt-6 rounded-2xl bg-[var(--datecn-cream)] p-6 text-center" id="datecn-register-panel" role="tabpanel">
      <h3 className="text-2xl font-bold">{auth("registerTitle")}</h3>
      <p className="mt-3 leading-7 text-[var(--datecn-muted)]">{auth("registerBody")}</p>
      <Link className="datecn-primary-button mt-6 inline-flex" href={`/${locale}/demo/me`}>{auth("registerCta")}</Link>
      <button className="mt-4 block w-full text-sm font-bold text-[var(--datecn-wine)]" onClick={() => setTab("sign-in")} type="button">{auth("backToSignIn")}</button>
    </section>}
  </div>;
}
