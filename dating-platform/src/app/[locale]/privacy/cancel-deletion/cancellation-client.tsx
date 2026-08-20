"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

const credentialPattern = /^[A-Za-z0-9_-]{43}$/u;

const fragmentCredential = () => {
  const values = new URLSearchParams(window.location.hash.slice(1));
  const credential = values.get("credential");
  return values.size === 1 && credential && credentialPattern.test(credential) ? credential : null;
};

const clearFragment = () => window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
const subscribeToFragment = (notify: () => void) => {
  window.addEventListener("hashchange", notify); window.addEventListener("popstate", notify);
  return () => { window.removeEventListener("hashchange", notify); window.removeEventListener("popstate", notify); };
};
const noServerCredential = () => null;

export function DeletionCancellationClient({ locale }: { locale: "en" | "zh-CN" }) {
  const t = useTranslations("privacyCredentials");
  const credential = useSyncExternalStore(subscribeToFragment, fragmentCredential, noServerCredential);
  const [status, setStatus] = useState<"ready" | "invalid" | "submitting" | "success" | "error">("ready");
  const idempotencyKey = useRef(`privacy-cancel-${crypto.randomUUID()}`);
  const visibleStatus = status === "ready" && !credential ? "invalid" : status;

  const cancel = async () => {
    if (!credential || status === "submitting") return;
    setStatus("submitting");
    try {
      const response = await fetch("/api/v1/me/delete", { method: "DELETE", headers: {
        authorization: `Bearer ${credential}`, "content-type": "application/json",
        "idempotency-key": idempotencyKey.current,
      }, body: "{}", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("CANCELLATION_FAILED");
      clearFragment(); setStatus("success");
    } catch { setStatus("error"); }
  };

  return <section className="mt-8 space-y-5" data-locale={locale}>
    <h1 className="text-3xl font-semibold">{t("cancelTitle")}</h1>
    <p className="text-stone-600">{t("cancelIntro")}</p>
    {visibleStatus !== "success" && <button type="button" onClick={cancel}
      disabled={!credential || visibleStatus === "submitting"}
      className="rounded-xl bg-rose-700 px-5 py-3 font-medium text-white disabled:opacity-50">
      {t(visibleStatus === "submitting" ? "canceling" : "confirm")}</button>}
    <div aria-live="polite">
      {visibleStatus === "invalid" && <p className="text-red-700">{t("invalid")}</p>}
      {visibleStatus === "error" && <p className="text-red-700">{t("cancelError")}</p>}
      {visibleStatus === "success" && <p className="text-emerald-700">{t("canceled")}</p>}
    </div>
  </section>;
}
