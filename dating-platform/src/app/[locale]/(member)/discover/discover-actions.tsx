"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

type State = "idle" | "working" | "liked" | "matched" | "reported" | "blocked" | "denied" | "error";
const reportReasons = ["HARASSMENT", "HATE_OR_ABUSE", "IMPERSONATION", "MINOR_SAFETY", "SCAM_OR_FRAUD",
  "SEXUAL_CONTENT", "SPAM", "THREATS_OR_VIOLENCE", "OTHER_SAFETY"] as const;
const reportLocales = { en: "en", zh: "zh-CN" } as const;

export function DiscoverActions({ locale, profileId, displayName }: {
  locale: "en" | "zh";
  profileId: string;
  displayName: string;
}) {
  const t = useTranslations("discoverActions");
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [reportOpen, setReportOpen] = useState(false);
  const keys = useRef({ like: crypto.randomUUID(), block: crypto.randomUUID(), report: crypto.randomUUID() });
  const blocked = state === "blocked";

  async function mutate(path: string, body: unknown | null, key: string) {
    const response = await fetch(path, { method: "POST", headers: {
      ...(body ? { "content-type": "application/json" } : {}), "idempotency-key": key,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { code?: string };
      if (response.status === 404 || payload.code === "INTERACTION_NOT_ALLOWED") throw new Error("DENIED");
      throw new Error("REQUEST_FAILED");
    }
    return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
  }

  async function like() {
    setState("working");
    try {
      const result = await mutate(`/api/v1/profiles/${profileId}/like`, null, keys.current.like);
      setState(result.matched === true ? "matched" : "liked");
    } catch (error) { setState(error instanceof Error && error.message === "DENIED" ? "denied" : "error"); }
  }

  async function block() {
    setState("working");
    try {
      await mutate(`/api/v1/profiles/${profileId}/block`, null, keys.current.block);
      setReportOpen(false); setState("blocked");
    } catch (error) { setState(error instanceof Error && error.message === "DENIED" ? "denied" : "error"); }
  }

  async function startConversation() {
    setState("working");
    try {
      const response = await fetch("/api/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId }),
      });
      if (!response.ok) throw new Error("REQUEST_FAILED");
      router.push(`/${locale}/messages`);
    } catch { setState("error"); }
  }

  async function report(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setState("working");
    try {
      await mutate("/api/v1/reports", {
        clientId: keys.current.report,
        targetProfileId: profileId,
        reason: String(data.get("reason") ?? ""),
        locale: reportLocales[locale],
        explanation: String(data.get("explanation") ?? "").trim(),
        evidenceReferences: [],
      }, keys.current.report);
      setState("reported"); setReportOpen(false);
    } catch { setState("error"); }
  }

  const feedback = state === "matched" ? t("matched", { name: displayName })
    : state === "liked" ? t("liked", { name: displayName })
      : state === "reported" ? t("reported")
        : state === "blocked" ? t("blocked", { name: displayName })
          : state === "denied" ? t("denied")
            : state === "error" ? t("error") : "";

  return <div className="mt-5 border-t border-rose-100 pt-4">
    <div className="flex flex-wrap gap-2">
      <button aria-label={t("likeName", { name: displayName })} className="datecn-primary-button text-sm disabled:opacity-50" disabled={blocked || state === "working"} onClick={like} type="button">{t("like")}</button>
      <button aria-expanded={reportOpen} aria-label={t("reportName", { name: displayName })} className="datecn-ghost-button disabled:opacity-50" disabled={blocked || state === "working"} onClick={() => setReportOpen((value) => !value)} type="button">{t("report")}</button>
      <button aria-label={t("blockName", { name: displayName })} className="datecn-ghost-button text-red-800 disabled:opacity-50" disabled={blocked || state === "working"} onClick={block} type="button">{t("block")}</button>
      {state === "matched" && <button className="datecn-ghost-button" onClick={startConversation}
        type="button">{t("message")}</button>}
    </div>
    {reportOpen && <form aria-label={t("reportName", { name: displayName })} className="mt-4 space-y-3 rounded-2xl bg-rose-50 p-4" onSubmit={report}>
      <label className="block text-sm font-semibold">{t("reason")}<select className="mt-1 w-full rounded-xl border border-rose-200 bg-white p-2" name="reason" required>{reportReasons.map((reason) => <option key={reason} value={reason}>{t(`reasons.${reason}`)}</option>)}</select></label>
      <label className="block text-sm font-semibold">{t("explanation")}<textarea className="mt-1 w-full rounded-xl border border-rose-200 bg-white p-2" maxLength={1000} minLength={1} name="explanation" required rows={3} /></label>
      <button className="datecn-primary-button text-sm" disabled={state === "working"}>{t("submitReport")}</button>
    </form>}
    <p aria-live="polite" className={`mt-3 min-h-5 text-sm ${state === "error" || state === "denied" ? "text-red-700" : "text-emerald-800"}`} role={state === "error" || state === "denied" ? "alert" : "status"}>{feedback}</p>
  </div>;
}
