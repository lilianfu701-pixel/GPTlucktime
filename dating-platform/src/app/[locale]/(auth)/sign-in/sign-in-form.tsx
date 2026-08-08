"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { authClient } from "@/modules/auth/client";

const copy = {
  en: {
    email: "Email address",
    password: "Password",
    submit: "Sign in",
    submitting: "Signing in…",
    error: "We could not sign you in. Check your email and password and try again.",
  },
  zh: {
    email: "电子邮箱",
    password: "密码",
    submit: "登录",
    submitting: "正在登录…",
    error: "暂时无法登录。请检查邮箱和密码后重试。",
  },
} as const;

export default function SignInForm({ locale }: { locale: "en" | "zh" }) {
  const router = useRouter();
  const text = copy[locale];
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
        {text.email}
        <input className="mt-2 w-full rounded-2xl border border-rose-200 px-4 py-3 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200" name="email" type="email" autoComplete="email" required />
      </label>
      <label className="block text-sm font-semibold text-stone-800">
        {text.password}
        <input className="mt-2 w-full rounded-2xl border border-rose-200 px-4 py-3 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200" name="password" type="password" autoComplete="current-password" required />
      </label>
      <button className="w-full rounded-full bg-rose-700 px-6 py-3 font-semibold text-white hover:bg-rose-800 disabled:cursor-wait disabled:opacity-60" disabled={status === "submitting"}>
        {status === "submitting" ? text.submitting : text.submit}
      </button>
      <p className="min-h-6 text-sm text-red-700" role="status" aria-live="polite">
        {status === "error" ? text.error : null}
      </p>
    </form>
  );
}
