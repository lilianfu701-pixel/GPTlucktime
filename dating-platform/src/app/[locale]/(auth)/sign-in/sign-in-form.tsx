"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type FormEvent, type KeyboardEvent } from "react";

import { authClient } from "@/modules/auth/client";

type AuthTab = "sign-in" | "register";
type SubmitState = "idle" | "submitting" | "error";
const inputClass = "mt-2 w-full rounded-2xl border border-rose-200 px-4 py-3 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200";

function isAdult(birthDate: string, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(birthDate)) return false;
  const [year, month, day] = birthDate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) return false;
  return parsed <= new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
}

export default function SignInForm({ locale }: { locale: "en" | "zh" }) {
  const router = useRouter();
  const t = useTranslations("signIn");
  const auth = useTranslations("datecn.auth");
  const [status, setStatus] = useState<SubmitState>("idle");
  const [registrationStatus, setRegistrationStatus] = useState<SubmitState | "email-sent">("idle");
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registeredEmail, setRegisteredEmail] = useState("");
  const [phoneStatus, setPhoneStatus] = useState<"idle" | "sending" | "sent" | "verifying" | "verified" | "error">("idle");
  const [showPassword, setShowPassword] = useState(false);
  const [tab, setTab] = useState<AuthTab>("sign-in");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    const data = new FormData(event.currentTarget);
    const result = await authClient.signIn.email({
      email: String(data.get("email") ?? ""), password: String(data.get("password") ?? ""),
      callbackURL: `/${locale}/onboarding`,
    }).catch(() => null);
    if (!result || result.error) { setStatus("error"); return; }
    router.push(`/${locale}/onboarding`);
    router.refresh();
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const email = String(data.get("registerEmail") ?? "").trim().toLowerCase();
    const password = String(data.get("registerPassword") ?? "");
    const birthDate = String(data.get("birthDate") ?? "");
    setRegistrationError(null);
    if (!isAdult(birthDate)) { setRegistrationError(auth("adultError")); return; }
    if (data.get("terms") !== "on") { setRegistrationError(auth("termsError")); return; }
    setRegistrationStatus("submitting");
    const result = await authClient.signUp.email({ name, email, password,
      callbackURL: `/${locale}/onboarding` }).catch(() => null);
    if (!result || result.error) {
      setRegistrationStatus("error"); setRegistrationError(auth("registerError")); return;
    }
    setRegisteredEmail(email);
    setRegistrationStatus("email-sent");
  }

  async function resendEmail() {
    setRegistrationError(null);
    const result = await authClient.sendVerificationEmail({ email: registeredEmail,
      callbackURL: `/${locale}/onboarding` }).catch(() => null);
    if (!result || result.error) setRegistrationError(auth("verificationError"));
  }

  async function sendPhoneCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phoneNumber = String(new FormData(event.currentTarget).get("phoneNumber") ?? "").trim();
    setPhoneStatus("sending");
    const result = await authClient.phoneNumber.sendOtp({ phoneNumber }).catch(() => null);
    setPhoneStatus(result && !result.error ? "sent" : "error");
  }

  async function verifyPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPhoneStatus("verifying");
    const result = await authClient.phoneNumber.verify({ phoneNumber: String(data.get("phoneNumber") ?? "").trim(),
      code: String(data.get("phoneCode") ?? "").trim(), updatePhoneNumber: true }).catch(() => null);
    setPhoneStatus(result && !result.error ? "verified" : "error");
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
      <label className="block text-sm font-semibold text-stone-800">{t("email")}<input className={inputClass} name="email" type="email" autoComplete="email" required /></label>
      <label className="block text-sm font-semibold text-stone-800">{t("password")}<span className="relative mt-2 block"><input className="w-full rounded-2xl border border-rose-200 px-4 py-3 pr-20 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required /><button aria-label={showPassword ? auth("hidePassword") : auth("showPassword")} className="absolute inset-y-0 right-3 text-xs font-bold text-[var(--datecn-wine)]" onClick={() => setShowPassword((value) => !value)} type="button">{showPassword ? auth("hidePassword") : auth("showPassword")}</button></span></label>
      <button className="datecn-primary-button w-full disabled:cursor-wait disabled:opacity-60" disabled={status === "submitting"}>{status === "submitting" ? t("submitting") : t("submit")}</button>
      <p aria-live="polite" className="min-h-6 text-sm text-red-700" role="status">{status === "error" ? t("error") : null}</p>
    </form> : <section aria-labelledby="datecn-register-tab" className="mt-6" id="datecn-register-panel" role="tabpanel">
      {registrationStatus !== "email-sent" ? <form aria-label={auth("registerTab")} className="space-y-4" onSubmit={register}>
        <label className="block text-sm font-semibold">{auth("displayName")}<input className={inputClass} name="name" autoComplete="name" maxLength={80} required /></label>
        <label className="block text-sm font-semibold">{t("email")}<input className={inputClass} name="registerEmail" type="email" autoComplete="email" required /></label>
        <div><label className="block text-sm font-semibold" htmlFor="register-password">{t("password")}</label><input aria-describedby="register-password-hint" className={inputClass} id="register-password" name="registerPassword" type="password" autoComplete="new-password" minLength={12} required /><span className="mt-1 block text-xs text-[var(--datecn-muted)]" id="register-password-hint">{auth("passwordHint")}</span></div>
        <div><label className="block text-sm font-semibold" htmlFor="register-birth-date">{auth("birthDate")}</label><input aria-describedby="register-eligibility register-error" aria-invalid={Boolean(registrationError)} className={inputClass} id="register-birth-date" name="birthDate" type="date" required /><span className="mt-1 block text-xs text-[var(--datecn-muted)]" id="register-eligibility">{auth("birthDateHint")}</span></div>
        <label className="flex items-start gap-3 text-sm leading-6"><input className="mt-1 size-4" name="terms" type="checkbox" required /><span>{auth("termsAcknowledgement")}</span></label>
        <p aria-live="assertive" className="min-h-6 text-sm text-red-700" id="register-error" role={registrationError ? "alert" : undefined}>{registrationError}</p>
        <button className="datecn-primary-button w-full disabled:opacity-60" disabled={registrationStatus === "submitting"}>{registrationStatus === "submitting" ? auth("registering") : auth("registerCta")}</button>
      </form> : <div className="rounded-2xl bg-[var(--datecn-cream)] p-5">
        <h3 className="text-xl font-bold">{auth("checkEmailTitle")}</h3>
        <p className="mt-2 text-sm leading-6 text-[var(--datecn-muted)]">{auth("checkEmailBody")}</p>
        <button className="mt-3 text-sm font-bold text-[var(--datecn-wine)]" onClick={resendEmail} type="button">{auth("resendEmail")}</button>
        <details className="mt-5 border-t border-rose-200 pt-4"><summary className="cursor-pointer font-bold">{auth("phoneTitle")}</summary>
          <p className="mt-2 text-xs leading-5 text-[var(--datecn-muted)]">{auth("phoneBody")}</p>
          <form className="mt-3 space-y-3" onSubmit={phoneStatus === "sent" ? verifyPhone : sendPhoneCode}>
            <label className="block text-sm font-semibold">{auth("phoneNumber")}<input className={inputClass} name="phoneNumber" type="tel" autoComplete="tel" required /></label>
            {phoneStatus === "sent" && <label className="block text-sm font-semibold">{auth("phoneCode")}<input className={inputClass} inputMode="numeric" name="phoneCode" autoComplete="one-time-code" required /></label>}
            <button className="datecn-ghost-button" disabled={phoneStatus === "sending" || phoneStatus === "verifying"}>{phoneStatus === "sent" ? auth("verifyPhone") : auth("sendPhoneCode")}</button>
            <p aria-live="polite" className={`text-sm ${phoneStatus === "error" ? "text-red-700" : "text-emerald-800"}`}>{phoneStatus === "verified" ? auth("phoneVerified") : phoneStatus === "error" ? auth("verificationError") : null}</p>
          </form>
        </details>
      </div>}
      <button className="mt-4 block w-full text-sm font-bold text-[var(--datecn-wine)]" onClick={() => setTab("sign-in")} type="button">{auth("backToSignIn")}</button>
    </section>}
  </div>;
}
