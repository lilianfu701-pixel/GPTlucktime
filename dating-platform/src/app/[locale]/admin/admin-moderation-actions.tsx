"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

type Queue = "profile_media" | "reports" | "appeals" | "billing_discrepancies" | "verification_failures" | "configuration_changes";
type CaseDetail = { case: { status: string; subjectUserId: string; targetType: string; reasonCode: string;
  messageId: string | null; expectedVersion: number }; timeline: Array<{ id: string; actorRole: string;
  eventType: string; createdAt: string }>; actions: Array<{ id: string; actionType: string; expiresAt: string }> };

export function AdminModerationActions({ queue, itemId, status }: { queue: Queue; itemId: string; status: string }) {
  const t = useTranslations("adminModeration");
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [currentStatus, setCurrentStatus] = useState(status);
  const [feedback, setFeedback] = useState("");
  const [working, setWorking] = useState(false);
  const headers = () => ({ "content-type": "application/json", "idempotency-key": `moderation-${crypto.randomUUID()}` });
  const send = async (path: string, body: unknown) => {
    setWorking(true); setFeedback("");
    try {
      const response = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
      if (!response.ok) throw new Error();
      const result = await response.json() as Record<string, unknown>;
      setFeedback(t("saved"));
      return result;
    } catch { setFeedback(t("error")); return null; }
    finally { setWorking(false); }
  };

  async function openCase() {
    setWorking(true); setFeedback("");
    try {
      const response = await fetch(`/api/v1/admin/cases/${itemId}`, { method: "GET" });
      if (!response.ok) throw new Error();
      setDetail(await response.json() as CaseDetail);
    } catch { setFeedback(t("error")); }
    finally { setWorking(false); }
  }

  async function transition(nextStatus: "triaged" | "under_review") {
    const result = await send(`/api/v1/admin/cases/${itemId}/actions`, { action: "transition", nextStatus });
    if (result) { setCurrentStatus(nextStatus); setDetail((value) => value ? { ...value,
      case: { ...value.case, status: nextStatus } } : value); }
  }

  async function restrict(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const data = new FormData(event.currentTarget);
    await send(`/api/v1/admin/cases/${itemId}/actions`, { action: "temporary_restriction",
      subjectUserId: detail.case.subjectUserId, reason: String(data.get("reason") ?? ""),
      durationHours: Number(data.get("durationHours")), expectedVersion: detail.case.expectedVersion });
  }

  async function mediaDecision(form: HTMLFormElement, decision: "approved" | "rejected") {
    const data = new FormData(form);
    const result = await send(`/api/v1/admin/media-reviews/${itemId}/decision`, {
      decision, reason: String(data.get("reason") ?? ""),
    });
    if (result) setCurrentStatus(decision);
  }

  async function appealDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const decision = String(data.get("decision"));
    const expiry = String(data.get("restrictionExpiresAt") ?? "");
    const result = await send(`/api/v1/admin/appeals/${itemId}/decision`, { decision,
      summary: String(data.get("summary") ?? ""), ...(decision === "modified" && expiry
        ? { restrictionExpiresAt: new Date(expiry).toISOString() } : {}) });
    if (result) setCurrentStatus(decision);
  }

  async function startAppealReview() {
    const result = await send(`/api/v1/admin/appeals/${itemId}/review`, {});
    if (result) setCurrentStatus("under_review");
  }

  return <div className="mt-4 border-t border-stone-200 pt-4">
    {queue === "reports" && <>
      {!detail && <button className="rounded-full border border-stone-400 px-3 py-2 text-sm font-semibold" disabled={working}
        onClick={openCase} type="button">{t("openCase")}</button>}
      {detail && <div className="space-y-4">
        <dl className="grid gap-2 text-xs text-stone-600"><div><dt className="font-semibold">{t("targetType")}</dt><dd>{detail.case.targetType}</dd></div>
          <div><dt className="font-semibold">{t("reasonCode")}</dt><dd>{detail.case.reasonCode}</dd></div>
          {detail.case.messageId && <div><dt className="sr-only">{t("messageReferenceLabel")}</dt><dd>{t("messageReference", { id: detail.case.messageId })}</dd></div>}</dl>
        {currentStatus === "submitted" && <button className="rounded-full bg-stone-900 px-3 py-2 text-sm font-semibold text-white" disabled={working}
          onClick={() => transition("triaged")} type="button">{t("triage")}</button>}
        {currentStatus === "triaged" && <button className="rounded-full bg-stone-900 px-3 py-2 text-sm font-semibold text-white" disabled={working}
          onClick={() => transition("under_review")} type="button">{t("beginReview")}</button>}
        {currentStatus === "under_review" && <form className="space-y-3" onSubmit={restrict}>
          <label className="block text-sm font-semibold">{t("restrictionReason")}<textarea className="mt-1 w-full rounded-xl border p-2" maxLength={500} minLength={1} name="reason" required /></label>
          <label className="block text-sm font-semibold">{t("durationHours")}<input className="ml-2 w-24 rounded-xl border p-2" defaultValue={24} max={720} min={1} name="durationHours" type="number" required /></label>
          <button className="rounded-full bg-red-800 px-3 py-2 text-sm font-semibold text-white" disabled={working}>{t("restrict")}</button>
        </form>}
        <section aria-labelledby={`timeline-${itemId}`}><h3 className="font-semibold" id={`timeline-${itemId}`}>{t("timeline")}</h3>
          <ol className="mt-2 space-y-2">{detail.timeline.map((event) => <li className="border-l-2 border-stone-300 pl-3 text-xs" key={event.id}>
            <p className="font-semibold">{t.has(`events.${event.eventType}`) ? t(`events.${event.eventType}`) : t("events.other")}</p>
            <p className="text-stone-500">{event.actorRole} · <time dateTime={event.createdAt}>{new Intl.DateTimeFormat().format(new Date(event.createdAt))}</time></p>
          </li>)}</ol></section>
      </div>}
    </>}
    {queue === "profile_media" && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void mediaDecision(event.currentTarget, "approved"); }}>
      <label className="block text-sm font-semibold">{t("reviewReason")}<textarea className="mt-1 w-full rounded-xl border p-2" maxLength={500} minLength={1} name="reason" required /></label>
      <div className="flex gap-2"><button className="rounded-full bg-emerald-800 px-3 py-2 text-sm font-semibold text-white" disabled={working || currentStatus === "approved"}>{t("approvePhoto")}</button>
        <button className="rounded-full border border-red-700 px-3 py-2 text-sm font-semibold text-red-800" disabled={working || currentStatus === "rejected"}
          onClick={(event) => { const form = event.currentTarget.form; if (form?.reportValidity()) void mediaDecision(form, "rejected"); }} type="button">{t("rejectPhoto")}</button></div>
    </form>}
    {queue === "appeals" && currentStatus === "submitted" && <button className="rounded-full bg-stone-900 px-3 py-2 text-sm font-semibold text-white"
      disabled={working} onClick={startAppealReview} type="button">{t("beginAppealReview")}</button>}
    {queue === "appeals" && currentStatus === "under_review" && <form className="space-y-3" onSubmit={appealDecision}>
      <label className="block text-sm font-semibold">{t("appealDecision")}<select className="ml-2 rounded-xl border p-2" name="decision">
        <option value="upheld">{t("upheld")}</option><option value="overturned">{t("overturned")}</option><option value="modified">{t("modified")}</option>
      </select></label>
      <label className="block text-sm font-semibold">{t("decisionSummary")}<textarea className="mt-1 w-full rounded-xl border p-2" maxLength={500} minLength={1} name="summary" required /></label>
      <label className="block text-sm font-semibold">{t("modifiedExpiry")}<input className="ml-2 rounded-xl border p-2" name="restrictionExpiresAt" type="datetime-local" /></label>
      <button className="rounded-full bg-stone-900 px-3 py-2 text-sm font-semibold text-white" disabled={working}>{t("finalizeAppeal")}</button>
    </form>}
    <p aria-live="polite" className="mt-3 min-h-5 text-xs" role={feedback === t("error") ? "alert" : "status"}>{feedback}</p>
  </div>;
}
