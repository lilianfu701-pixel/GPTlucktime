"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

type MemberCase = { originalCaseId: string; caseStatus: string; finalizedAt: string | null;
  appeal: { id: string; status: string; finalDecisionSummary: string | null } | null };

export function AppealSettings() {
  const t = useTranslations("appealSettings");
  const [cases, setCases] = useState<MemberCase[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "working" | "submitted" | "error">("loading");
  useEffect(() => {
    let active = true;
    fetch("/api/v1/me/appeals", { method: "GET" }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await response.json() as { cases?: MemberCase[] };
      if (active) { setCases(Array.isArray(body.cases) ? body.cases : []); setState("ready"); }
    }).catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>, originalCaseId: string) {
    event.preventDefault(); setState("working");
    const statement = String(new FormData(event.currentTarget).get("statement") ?? "").trim();
    const response = await fetch("/api/v1/me/appeals", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ originalCaseId, statement }) }).catch(() => null);
    if (!response?.ok) { setState("error"); return; }
    const appeal = await response.json() as { id: string; status: string };
    setCases((current) => current.map((item) => item.originalCaseId === originalCaseId
      ? { ...item, appeal: { ...appeal, finalDecisionSummary: null } } : item));
    setState("submitted");
  }

  return <div className="mt-8 space-y-5">
    {state === "loading" && <p aria-live="polite">{t("loading")}</p>}
    {cases.map((item) => <article className="rounded-2xl border border-rose-100 p-5" key={item.originalCaseId}>
      <p className="text-sm font-semibold">{t("caseReference", { id: item.originalCaseId })}</p>
      <p className="mt-1 text-sm text-stone-600">{t("caseStatus", { status: item.caseStatus })}</p>
      {item.appeal ? <div className="mt-4 rounded-xl bg-rose-50 p-4"><p>{t("appealStatus", { status: item.appeal.status })}</p>
        {item.appeal.finalDecisionSummary && <p className="mt-2 text-sm">{item.appeal.finalDecisionSummary}</p>}</div>
        : <form className="mt-4 space-y-3" onSubmit={(event) => submit(event, item.originalCaseId)}>
          <label className="block text-sm font-semibold">{t("statement")}<textarea aria-describedby={`appeal-hint-${item.originalCaseId}`}
            className="mt-1 w-full rounded-xl border border-rose-200 p-3" maxLength={2000} minLength={1} name="statement" required rows={4} /></label>
          <p className="text-xs text-stone-500" id={`appeal-hint-${item.originalCaseId}`}>{t("statementHint")}</p>
          <button className="datecn-primary-button text-sm" disabled={state === "working"}>{t("submit")}</button>
        </form>}
    </article>)}
    {state === "ready" && cases.length === 0 && <p>{t("empty")}</p>}
    <p aria-live="polite" className={`min-h-6 text-sm ${state === "error" ? "text-red-700" : "text-emerald-800"}`}
      role={state === "error" ? "alert" : "status"}>{state === "submitted" ? t("submitted") : state === "error" ? t("error") : ""}</p>
  </div>;
}
