"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import {
  CoalescedAbortableRequests,
  createRealtimeClient,
  PendingSendLedger,
  recoverAllMessagePages,
  requireRealtimeRecoveryResponse,
  type RealtimeConnectionState,
  type RecoveredMessage,
} from "@/modules/messaging/realtime-client";
import { createPollingMessageClient, type PollingMessageClient } from "@/modules/messaging/polling-client";
import { createHttpReceiptSender } from "@/modules/messaging/http-receipt-client";

type Conversation = { id: string; profile?: { id?: string; displayName?: string } };
type Receipt = { messageId: string; sequence: number; deliveredAt: string | null; readAt: string | null };
type MessageTransportClient = Pick<PollingMessageClient,
  "start" | "join" | "refresh" | "markDelivered" | "markRead" | "stop" | "store">;

export function MessagesClient({ realtimeUrl }: { realtimeUrl: string | null }) {
  const t = useTranslations("messagesPage");
  const brand = useTranslations("brand");
  const [state, setState] = useState<RealtimeConnectionState>("connecting");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, RecoveredMessage[]>>({});
  const [receipts, setReceipts] = useState<Record<string, Record<string, Receipt>>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendDenied, setSendDenied] = useState(false);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportedIds, setReportedIds] = useState<Set<string>>(() => new Set());
  const [reportError, setReportError] = useState(false);
  const clientRef = useRef<MessageTransportClient | null>(null);
  const selectedRef = useRef<string | null>(null);
  const draftRef = useRef("");
  const ledgerRef = useRef<PendingSendLedger | null>(null);
  const receiptGenerationsRef = useRef(new Map<string, number>());
  const receiptRequestsRef = useRef(new CoalescedAbortableRequests());
  const receiptLastRequestedAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/conversations?pageSize=50", { credentials: "same-origin" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("CONVERSATIONS_UNAVAILABLE")))
      .then((result: { conversations?: Conversation[] }) => {
        if (!active) return;
        const safe = Array.isArray(result.conversations) ? result.conversations.slice(0, 50) : [];
        setConversations(safe);
        const first = safe[0]?.id;
        if (first) {
          selectedRef.current = first;
          setSelected(first);
          const initialDraft = localStorage.getItem(`heartline:draft:${first}`)?.slice(0, 2000) ?? "";
          draftRef.current = initialDraft;
          setDraft(initialDraft);
        }
      }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const recover = useCallback(async (conversationId: string, afterSequence: number, signal?: AbortSignal) =>
    recoverAllMessagePages(async (cursor, pageSignal) => {
      const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?afterSequence=${cursor}&pageSize=100`, {
        credentials: "same-origin",
        signal: pageSignal,
      });
      requireRealtimeRecoveryResponse(response);
      const result = await response.json() as { messages?: RecoveredMessage[]; nextAfterSequence?: number | null };
      return {
        messages: Array.isArray(result.messages) ? result.messages : [],
        nextAfterSequence: Number.isSafeInteger(result.nextAfterSequence)
          ? result.nextAfterSequence ?? null
          : null,
      };
    }, { afterSequence, signal }), []);

  const sendPollingReceipt = useCallback((kind: "delivered" | "read", message: RecoveredMessage, at: string, signal: AbortSignal) =>
    createHttpReceiptSender()(kind, message, at, signal), []);

  const loadReceipts = useCallback((conversationId: string) => receiptRequestsRef.current.run(conversationId, async (signal) => {
    const generation = (receiptGenerationsRef.current.get(conversationId) ?? 0) + 1;
    receiptGenerationsRef.current.set(conversationId, generation);
    const isCurrent = () => receiptGenerationsRef.current.get(conversationId) === generation;
    const rows: Receipt[] = [];
    let cursor = 0;
    while (!signal?.aborted) {
      const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}/receipts?afterSequence=${cursor}&pageSize=100`, { credentials: "same-origin", signal });
      if (!response.ok) return;
      const result = await response.json() as { visible?: boolean; receipts?: Receipt[]; nextAfterSequence?: number | null };
      if (result.visible !== true) {
        if (isCurrent()) setReceipts((current) => ({ ...current, [conversationId]: {} }));
        receiptRequestsRef.current.cancel(conversationId);
        return;
      }
      if (Array.isArray(result.receipts)) rows.push(...result.receipts);
      if (!result.nextAfterSequence || result.nextAfterSequence <= cursor) break;
      cursor = result.nextAfterSequence;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (!signal?.aborted && isCurrent()) {
      setReceipts((current) => ({
        ...current,
        [conversationId]: Object.fromEntries(rows.map((receipt) => [receipt.messageId, receipt])),
      }));
    }
  }), []);

  const requestActiveReceipts = useCallback(async (conversationId: string) => {
    if (selectedRef.current !== conversationId || document.visibilityState === "hidden") return;
    const now = Date.now();
    const previous = receiptLastRequestedAtRef.current.get(conversationId) ?? -Infinity;
    if (now - previous < 10_000) return;
    receiptLastRequestedAtRef.current.set(conversationId, now);
    try {
      await loadReceipts(conversationId);
    } catch {
      setReceipts((current) => current[conversationId]
        ? current
        : { ...current, [conversationId]: {} });
    }
  }, [loadReceipts]);

  useEffect(() => () => receiptRequestsRef.current.cancelAll(), []);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      await requestActiveReceipts(selected);
      if (active) timer = setTimeout(() => { void run(); }, 10_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void requestActiveReceipts(selected);
    };
    void run();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [selected, requestActiveReceipts]);

  useEffect(() => {
    const onMessages = (conversationId: string, rows: RecoveredMessage[]) => {
      setMessages((current) => ({ ...current, [conversationId]: rows }));
      void requestActiveReceipts(conversationId);
    };
    const client: MessageTransportClient = realtimeUrl
      ? createRealtimeClient({
        url: realtimeUrl,
        fetchTicket: async () => {
          const response = await fetch("/api/v1/realtime/ticket", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          if (!response.ok) throw new Error("REALTIME_UNAVAILABLE");
          return response.json() as Promise<{ ticket: string; expiresAt: string }>;
        },
        recover,
        onState: setState,
        onMessages,
      })
      : createPollingMessageClient({ recover, sendReceipt: sendPollingReceipt, onState: setState, onMessages });
    clientRef.current = client;
    void client.start();
    if (selectedRef.current) void client.join(selectedRef.current).catch(() => setState("failed"));
    return () => {
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [realtimeUrl, recover, requestActiveReceipts, sendPollingReceipt]);

  useEffect(() => {
    if (!selected) return;
    const receiptRequests = receiptRequestsRef.current;
    void clientRef.current?.join(selected).catch(() => setState("failed"));
    return () => {
      receiptRequests.cancel(selected);
    };
  }, [selected]);

  const selectConversation = (conversationId: string) => {
    selectedRef.current = conversationId;
    setSelected(conversationId);
    const nextDraft = localStorage.getItem(`heartline:draft:${conversationId}`)?.slice(0, 2000) ?? "";
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  };

  useEffect(() => {
    if (!selected) return;
    const markVisibleRead = () => {
      if (document.visibilityState !== "visible") return;
      for (const message of (messages[selected] ?? []).filter(({ sender }) => sender === "them")) {
        void clientRef.current?.markRead(message).catch(() => undefined);
      }
    };
    markVisibleRead();
    document.addEventListener("visibilitychange", markVisibleRead);
    return () => document.removeEventListener("visibilitychange", markVisibleRead);
  }, [messages, selected]);

  const updateDraft = (value: string) => {
    const bounded = Array.from(value).slice(0, 2000).join("");
    draftRef.current = bounded;
    setDraft(bounded);
    if (selected) localStorage.setItem(`heartline:draft:${selected}`, bounded);
  };
  const send = async () => {
    if (!selected || !draft.trim() || sending) return;
    ledgerRef.current ??= new PendingSendLedger(localStorage);
    const pending = ledgerRef.current.prepare(selected, draft);
    setSending(true);
    setSendDenied(false);
    try {
      const response = await fetch(`/api/v1/conversations/${encodeURIComponent(selected)}/messages`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: pending.clientId, body: pending.body }),
      });
      if (!response.ok) throw new Error("SEND_FAILED");
      ledgerRef.current.clear(selected, pending.clientId);
      if (selectedRef.current === selected && draftRef.current === pending.body) updateDraft("");
      if (selectedRef.current === selected) await clientRef.current?.refresh(selected);
    } catch {
      // The local draft intentionally remains available for an explicit retry.
      setSendDenied(true);
    } finally {
      setSending(false);
    }
  };

  const reportMessage = async (message: RecoveredMessage) => {
    if (!selected || reportingId || reportedIds.has(message.id)) return;
    const targetProfileId = conversations.find(({ id }) => id === selected)?.profile?.id;
    if (!targetProfileId) { setReportError(true); return; }
    setReportingId(message.id);
    setReportError(false);
    try {
      const response = await fetch("/api/v1/reports", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: crypto.randomUUID(), targetProfileId, reason: "HARASSMENT",
          locale: document.documentElement.lang || "en", explanation: "Reported from member message controls.",
          messageId: message.id, conversationId: selected, evidenceReferences: [],
        }),
      });
      if (!response.ok) throw new Error("REPORT_FAILED");
      setReportedIds((current) => new Set(current).add(message.id));
    } catch { setReportError(true); }
    finally { setReportingId(null); }
  };

  return (
    <main className="min-h-screen bg-rose-50 px-4 py-8 text-stone-900">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-end justify-between gap-4">
          <div><p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">{brand("name")}</p><h1 className="mt-2 text-4xl font-semibold">{t("title")}</h1></div>
          <p className="rounded-full bg-white px-4 py-2 text-sm" aria-live="polite">
            {t(`states.${state}`)}
          </p>
        </div>
        <div className="mt-8 grid min-h-[36rem] overflow-hidden rounded-3xl bg-white shadow-sm md:grid-cols-[18rem_1fr]">
          <nav className="border-b border-stone-100 p-3 md:border-b-0 md:border-r" aria-label={t("title")}>
            {conversations.map((conversation) => <button key={conversation.id} type="button" onClick={() => selectConversation(conversation.id)} className={`block w-full rounded-2xl px-4 py-3 text-left ${selected === conversation.id ? "bg-rose-100" : "hover:bg-stone-50"}`}>{conversation.profile?.displayName ?? t("title")}</button>)}
          </nav>
          <section className="flex min-w-0 flex-col p-5">
            {!selected ? <p className="m-auto text-stone-500">{t("empty")}</p> : <>
              <ol className="flex-1 space-y-3 overflow-y-auto" aria-live="polite">
                {(messages[selected] ?? []).map((message) => <li key={message.id} className={`max-w-[80%] rounded-2xl px-4 py-3 ${message.sender === "me" ? "ml-auto bg-rose-700 text-white" : "bg-stone-100"}`}><p>{message.body}</p>{message.sender === "me" && receipts[selected]?.[message.id] && <span className="mt-1 block text-right text-xs opacity-75">{receipts[selected]?.[message.id]?.readAt ? t("read") : t("delivered")}</span>}{message.sender === "them" && <button type="button" className="mt-2 text-xs font-semibold text-red-800 underline underline-offset-2 disabled:text-stone-500" disabled={reportingId === message.id || reportedIds.has(message.id)} onClick={() => { void reportMessage(message); }}>{reportedIds.has(message.id) ? t("reported") : t("reportMessage")}</button>}</li>)}
              </ol>
              <div className="mt-4 flex gap-3">
                <textarea value={draft} disabled={sending} onChange={(event) => updateDraft(event.target.value)} placeholder={t("draft")} maxLength={2000} className="min-h-20 flex-1 resize-none rounded-2xl border border-stone-200 p-3" />
                <button type="button" disabled={sending || !draft.trim()} onClick={() => { void send(); }} className="self-end rounded-full bg-rose-700 px-6 py-3 font-semibold text-white disabled:opacity-50">{t("send")}</button>
              </div>
              <p aria-live="assertive" className="mt-2 min-h-5 text-sm text-red-700" role={sendDenied ? "alert" : undefined}>
                {sendDenied ? t("sendDenied") : null}
              </p>
              <p aria-live="polite" className={`min-h-5 text-sm ${reportError ? "text-red-700" : "text-emerald-800"}`} role={reportError ? "alert" : "status"}>
                {reportError ? t("reportError") : reportedIds.size > 0 ? t("reportSuccess") : null}
              </p>
            </>}
          </section>
        </div>
      </div>
    </main>
  );
}
