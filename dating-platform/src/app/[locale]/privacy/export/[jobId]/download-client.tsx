"use client";

import { useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

const credentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const jobPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

export function PrivacyExportDownloadClient({ locale, jobId }: { locale: "en" | "zh-CN"; jobId: string }) {
  const t = useTranslations("privacyCredentials");
  const credential = useSyncExternalStore(subscribeToFragment, fragmentCredential, noServerCredential);
  const [status, setStatus] = useState<"ready" | "invalid" | "submitting" | "success" | "auth" | "error">("ready");
  const visibleStatus = status === "ready" && (!credential || !jobPattern.test(jobId)) ? "invalid" : status;

  const download = async () => {
    if (!credential || !jobPattern.test(jobId) || status === "submitting") return;
    setStatus("submitting");
    try {
      const response = await fetch(`/api/v1/me/export?jobId=${encodeURIComponent(jobId)}`, { method: "GET",
        headers: { "x-export-download-token": credential }, cache: "no-store", credentials: "same-origin",
        referrerPolicy: "no-referrer" });
      if (response.status === 401 || response.status === 403) { setStatus("auth"); return; }
      if (!response.ok) throw new Error("EXPORT_DOWNLOAD_FAILED");
      const body = await response.blob();
      const objectUrl = URL.createObjectURL(body);
      try {
        const anchor = document.createElement("a"); anchor.href = objectUrl;
        anchor.download = "heartline-data-export.json"; anchor.rel = "noopener"; anchor.click();
      } finally { URL.revokeObjectURL(objectUrl); }
      clearFragment(); setStatus("success");
    } catch { setStatus("error"); }
  };

  return <section className="mt-8 space-y-5" data-locale={locale}>
    <h1 className="text-3xl font-semibold">{t("exportTitle")}</h1>
    <p className="text-stone-600">{t("exportIntro")}</p>
    {visibleStatus !== "success" && <button type="button" onClick={download}
      disabled={!credential || visibleStatus === "submitting" || visibleStatus === "invalid"}
      className="rounded-xl bg-rose-700 px-5 py-3 font-medium text-white disabled:opacity-50">
      {t(visibleStatus === "submitting" ? "downloading" : "download")}</button>}
    <div aria-live="polite">
      {visibleStatus === "invalid" && <p className="text-red-700">{t("invalid")}</p>}
      {visibleStatus === "error" && <p className="text-red-700">{t("downloadError")}</p>}
      {visibleStatus === "success" && <p className="text-emerald-700">{t("downloaded")}</p>}
      {visibleStatus === "auth" && <p className="text-amber-800">{t("signInPrompt")} <a className="underline"
        href={`/${locale}/sign-in`}>{t("signIn")}</a></p>}
    </div>
  </section>;
}
