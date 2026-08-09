"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createRealtimeClient,
  recoverAllMessagePages,
  type RealtimeConnectionState,
  type RecoveredMessage,
} from "@/modules/messaging/realtime-client";

type Conversation = { id: string; profile?: { displayName?: string } };
type Receipt = { messageId: string; deliveredAt: string | null; readAt: string | null };
const text = {
  en: { title: "Messages", empty: "Choose a conversation", draft: "Write a message", send: "Send", read: "Read", delivered: "Delivered", unavailable: "Real-time updates unavailable", states: { connecting: "Connecting", online: "Online", retrying: "Reconnecting", failed: "Connection failed" } },
  zh: { title: "消息", empty: "请选择一个会话", draft: "输入消息", send: "发送", read: "已读", delivered: "已送达", unavailable: "实时更新暂不可用", states: { connecting: "连接中", online: "在线", retrying: "正在重连", failed: "连接失败" } },
} as const;

export function MessagesClient({ locale, realtimeUrl }: { locale: "en" | "zh"; realtimeUrl: string | null }) {
  const labels = text[locale];
  const [state, setState] = useState<RealtimeConnectionState>(realtimeUrl ? "connecting" : "failed");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, RecoveredMessage[]>>({});
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const clientRef = useRef<ReturnType<typeof createRealtimeClient> | null>(null);

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
          setSelected(first);
          setDraft(localStorage.getItem(`heartline:draft:${first}`)?.slice(0, 2000) ?? "");
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
      if (!response.ok) throw new Error("MESSAGES_UNAVAILABLE");
      const result = await response.json() as { messages?: RecoveredMessage[]; nextAfterSequence?: number | null };
      return {
        messages: Array.isArray(result.messages) ? result.messages : [],
        nextAfterSequence: Number.isSafeInteger(result.nextAfterSequence)
          ? result.nextAfterSequence ?? null
          : null,
      };
    }, { afterSequence, signal }), []);

  const loadReceipts = useCallback(async (conversationId: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}/receipts?afterSequence=0`, {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) return;
    const result = await response.json() as { visible?: boolean; receipts?: Receipt[] };
    if (result.visible !== true || !Array.isArray(result.receipts)) return;
    setReceipts(Object.fromEntries(result.receipts.slice(0, 100).map((receipt) => [receipt.messageId, receipt])));
  }, []);

  useEffect(() => {
    if (!realtimeUrl) return;
    const client = createRealtimeClient({
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
      onMessages: (conversationId, rows) => {
        setMessages((current) => ({ ...current, [conversationId]: rows }));
        void loadReceipts(conversationId);
      },
    });
    clientRef.current = client;
    void client.start();
    return () => {
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [realtimeUrl, recover, loadReceipts]);

  useEffect(() => {
    if (!selected) return;
    void clientRef.current?.join(selected);
    const controller = new AbortController();
    void recover(selected, 0, controller.signal)
      .then((rows) => {
        setMessages((current) => ({ ...current, [selected]: rows }));
        void loadReceipts(selected, controller.signal);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [selected, recover, loadReceipts]);

  const selectConversation = (conversationId: string) => {
    setSelected(conversationId);
    setDraft(localStorage.getItem(`heartline:draft:${conversationId}`)?.slice(0, 2000) ?? "");
  };

  const updateDraft = (value: string) => {
    const bounded = Array.from(value).slice(0, 2000).join("");
    setDraft(bounded);
    if (selected) localStorage.setItem(`heartline:draft:${selected}`, bounded);
  };
  const send = async () => {
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    try {
      const response = await fetch(`/api/v1/conversations/${encodeURIComponent(selected)}/messages`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: crypto.randomUUID(), body: draft }),
      });
      if (!response.ok) throw new Error("SEND_FAILED");
      updateDraft("");
      const rows = await recover(selected, 0);
      setMessages((current) => ({ ...current, [selected]: rows }));
      void loadReceipts(selected);
    } catch {
      // The local draft intentionally remains available for an explicit retry.
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="min-h-screen bg-rose-50 px-4 py-8 text-stone-900">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-end justify-between gap-4">
          <div><p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">Heartline</p><h1 className="mt-2 text-4xl font-semibold">{labels.title}</h1></div>
          <p className="rounded-full bg-white px-4 py-2 text-sm" aria-live="polite">
            {realtimeUrl ? labels.states[state] : labels.unavailable}
          </p>
        </div>
        <div className="mt-8 grid min-h-[36rem] overflow-hidden rounded-3xl bg-white shadow-sm md:grid-cols-[18rem_1fr]">
          <nav className="border-b border-stone-100 p-3 md:border-b-0 md:border-r" aria-label={labels.title}>
            {conversations.map((conversation) => <button key={conversation.id} type="button" onClick={() => selectConversation(conversation.id)} className={`block w-full rounded-2xl px-4 py-3 text-left ${selected === conversation.id ? "bg-rose-100" : "hover:bg-stone-50"}`}>{conversation.profile?.displayName ?? labels.title}</button>)}
          </nav>
          <section className="flex min-w-0 flex-col p-5">
            {!selected ? <p className="m-auto text-stone-500">{labels.empty}</p> : <>
              <ol className="flex-1 space-y-3 overflow-y-auto" aria-live="polite">
                {(messages[selected] ?? []).map((message) => <li key={message.id} className={`max-w-[80%] rounded-2xl px-4 py-3 ${message.sender === "me" ? "ml-auto bg-rose-700 text-white" : "bg-stone-100"}`}><p>{message.body}</p>{message.sender === "me" && receipts[message.id] && <span className="mt-1 block text-right text-xs opacity-75">{receipts[message.id]?.readAt ? labels.read : labels.delivered}</span>}</li>)}
              </ol>
              <div className="mt-4 flex gap-3">
                <textarea value={draft} onChange={(event) => updateDraft(event.target.value)} placeholder={labels.draft} maxLength={2000} className="min-h-20 flex-1 resize-none rounded-2xl border border-stone-200 p-3" />
                <button type="button" disabled={sending || !draft.trim()} onClick={() => { void send(); }} className="self-end rounded-full bg-rose-700 px-6 py-3 font-semibold text-white disabled:opacity-50">{labels.send}</button>
              </div>
            </>}
          </section>
        </div>
      </div>
    </main>
  );
}
