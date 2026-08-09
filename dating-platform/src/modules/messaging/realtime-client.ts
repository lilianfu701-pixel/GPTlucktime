"use client";

import { io, type Socket } from "socket.io-client";

export type RealtimeConnectionState = "connecting" | "online" | "retrying" | "failed";
export type MessageNotification = { eventId: string; messageId: string; conversationId: string; sequence: number };
export type RecoveredMessage = {
  id: string; conversationId: string; sequence: number; body: string; sender: "me" | "them"; createdAt: string;
};

export class CoalescedRecovery {
  private readonly active = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  run(key: string, recover: () => Promise<void>) {
    const existing = this.active.get(key);
    if (existing) { existing.dirty = true; return existing.promise; }
    const state = { dirty: true, promise: Promise.resolve() };
    state.promise = (async () => {
      while (state.dirty) { state.dirty = false; await recover(); }
    })().finally(() => this.active.delete(key));
    this.active.set(key, state);
    return state.promise;
  }
}

export class RequestGenerations {
  private readonly values = new Map<string, number>();
  begin(key: string) {
    const generation = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, generation);
    return generation;
  }
  isCurrent(key: string, generation: number) {
    return this.values.get(key) === generation;
  }
}

export class PendingSendLedger {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {}
  private key(conversationId: string) { return `heartline:pending:${conversationId}`; }
  prepare(conversationId: string, body: string) {
    const raw = this.storage.getItem(this.key(conversationId));
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { clientId?: unknown; conversationId?: unknown; body?: unknown };
        if (saved.conversationId === conversationId && saved.body === body
          && typeof saved.clientId === "string") return saved as { clientId: string; conversationId: string; body: string };
      } catch { /* replace malformed local-only state */ }
    }
    const pending = { clientId: crypto.randomUUID(), conversationId, body };
    this.storage.setItem(this.key(conversationId), JSON.stringify(pending));
    return pending;
  }
  clear(conversationId: string, clientId: string) {
    const raw = this.storage.getItem(this.key(conversationId));
    if (!raw) return;
    try {
      if ((JSON.parse(raw) as { clientId?: unknown }).clientId === clientId) this.storage.removeItem(this.key(conversationId));
    } catch { this.storage.removeItem(this.key(conversationId)); }
  }
}

export async function recoverAllMessagePages(
  fetchPage: (afterSequence: number, signal?: AbortSignal) => Promise<{
    messages: RecoveredMessage[];
    nextAfterSequence: number | null;
  }>,
  options: {
    afterSequence: number;
    maxPagesPerRound?: number;
    signal?: AbortSignal;
    yieldToEventLoop?: () => Promise<void>;
  },
) {
  const rows: RecoveredMessage[] = [];
  let cursor = options.afterSequence;
  const perRound = Math.min(Math.max(options.maxPagesPerRound ?? 20, 1), 100);
  const yieldToEventLoop = options.yieldToEventLoop
    ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  while (true) {
    for (let page = 0; page < perRound; page += 1) {
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await fetchPage(cursor, options.signal);
      rows.push(...result.messages);
      if (!Number.isSafeInteger(result.nextAfterSequence) || !result.nextAfterSequence
        || result.nextAfterSequence <= cursor) return rows;
      cursor = result.nextAfterSequence;
    }
    await yieldToEventLoop();
  }
}

type Stored = { sequence: number; messageId: string; eventId?: string; message?: RecoveredMessage };

export class RealtimeMessageStore {
  private readonly byConversation = new Map<string, Map<number, Stored>>();
  private readonly messageIds = new Set<string>();
  private readonly eventIds = new Set<string>();

  mergeLive(event: MessageNotification) {
    if (this.eventIds.has(event.eventId) || this.messageIds.has(event.messageId)) return false;
    this.eventIds.add(event.eventId);
    this.messageIds.add(event.messageId);
    const rows = this.byConversation.get(event.conversationId) ?? new Map<number, Stored>();
    const existing = rows.get(event.sequence);
    rows.set(event.sequence, existing?.message
      ? { ...existing, eventId: event.eventId }
      : { sequence: event.sequence, messageId: event.messageId, eventId: event.eventId });
    this.byConversation.set(event.conversationId, rows);
    return true;
  }

  mergeRecovery(conversationId: string, messages: RecoveredMessage[]) {
    const rows = this.byConversation.get(conversationId) ?? new Map<number, Stored>();
    for (const message of [...messages].sort((left, right) => left.sequence - right.sequence)) {
      if (message.conversationId !== conversationId || !Number.isSafeInteger(message.sequence) || message.sequence < 1) continue;
      const existing = rows.get(message.sequence);
      if (existing && existing.messageId !== message.id) continue;
      this.messageIds.add(message.id);
      rows.set(message.sequence, { ...existing, sequence: message.sequence, messageId: message.id, message });
    }
    this.byConversation.set(conversationId, rows);
  }

  lastSequence(conversationId: string) {
    const sequences = [...(this.byConversation.get(conversationId)?.values() ?? [])]
      .flatMap((row) => row.message ? [row.sequence] : []);
    return sequences.length ? Math.max(...sequences) : 0;
  }

  messages(conversationId: string) {
    return [...(this.byConversation.get(conversationId)?.values() ?? [])]
      .sort((left, right) => left.sequence - right.sequence)
      .flatMap((row) => row.message ? [row.message] : []);
  }
}

export function createRealtimeClient(options: {
  url: string;
  fetchTicket: () => Promise<{ ticket: string; expiresAt: string }>;
  recover: (conversationId: string, afterSequence: number, signal?: AbortSignal) => Promise<RecoveredMessage[]>;
  onState: (state: RealtimeConnectionState) => void;
  onMessages: (conversationId: string, messages: RecoveredMessage[]) => void;
  maxRetries?: number;
  ackTimeoutMs?: number;
}) {
  const store = new RealtimeMessageStore();
  const conversations = new Set<string>();
  let socket: Socket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let stopped = false;
  let connecting = false;
  const stopController = new AbortController();
  const recoveryCoordinator = new CoalescedRecovery();
  const receiptState = new Map<string, "delivered" | "read">();

  const emitAck = async (event: string, payload: Record<string, unknown>) => {
    if (!socket?.connected) throw new Error("REALTIME_NOT_CONNECTED");
    const ack = await socket.timeout(options.ackTimeoutMs ?? 5_000).emitWithAck(event, payload) as unknown;
    if (!ack || typeof ack !== "object" || (ack as { ok?: unknown }).ok !== true) {
      throw new Error("REALTIME_ACTION_REJECTED");
    }
    return ack;
  };

  const sendReceipt = async (kind: "delivered" | "read", message: RecoveredMessage) => {
    if (message.sender !== "them") return;
    const previous = receiptState.get(message.id);
    if (previous === "read" || (previous === "delivered" && kind === "delivered")) return;
    await emitAck("receipt.update", {
      conversationId: message.conversationId,
      messageId: message.id,
      kind,
      at: new Date().toISOString(),
    });
    receiptState.set(message.id, kind);
  };

  const recover = async (conversationId: string) => {
    return recoveryCoordinator.run(conversationId, async () => {
        const rows = await options.recover(
          conversationId,
          store.lastSequence(conversationId),
          stopController.signal,
        );
        store.mergeRecovery(conversationId, rows);
        const hydrated = store.messages(conversationId);
        options.onMessages(conversationId, hydrated);
        for (const message of hydrated.slice(-100)) await sendReceipt("delivered", message);
    });
  };
  const joinAndRecover = async (conversationId: string) => {
    await emitAck("conversation.join", { conversationId });
    await recover(conversationId);
  };
  const schedule = () => {
    if (stopped || retryTimer) return;
    retries += 1;
    if (retries > (options.maxRetries ?? 8)) return options.onState("failed");
    options.onState("retrying");
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, Math.min(500 * 2 ** (retries - 1), 15_000));
  };
  const connect = async () => {
    if (stopped || connecting || socket?.connected) return;
    connecting = true;
    options.onState(retries ? "retrying" : "connecting");
    try {
      const ticket = await options.fetchTicket();
      if (stopped) return;
      socket?.removeAllListeners();
      socket?.disconnect();
      socket = io(options.url, { transports: ["websocket"], auth: { ticket: ticket.ticket }, reconnection: false });
      socket.on("connect", async () => {
        try {
          for (const conversationId of conversations) {
            await joinAndRecover(conversationId);
          }
          retries = 0;
          options.onState("online");
        } catch { socket?.disconnect(); }
      });
      socket.on("message.created", async (event: MessageNotification) => {
        try {
          if (store.mergeLive(event)) await recover(event.conversationId);
        } catch { socket?.disconnect(); }
      });
      socket.on("disconnect", schedule);
      socket.on("connect_error", schedule);
      if (refreshTimer) clearTimeout(refreshTimer);
      const refreshIn = Math.max(Date.parse(ticket.expiresAt) - Date.now() - 30_000, 1_000);
      refreshTimer = setTimeout(() => { socket?.disconnect(); }, refreshIn);
    } catch { schedule(); } finally { connecting = false; }
  };
  return {
    start: connect,
    async join(conversationId: string) {
      conversations.add(conversationId);
      if (socket?.connected) await joinAndRecover(conversationId);
    },
    async markDelivered(message: RecoveredMessage) {
      await sendReceipt("delivered", message);
    },
    async markRead(message: RecoveredMessage) {
      await sendReceipt("read", message);
    },
    async refresh(conversationId: string) {
      if (!conversations.has(conversationId)) conversations.add(conversationId);
      await recover(conversationId);
    },
    stop() {
      stopped = true;
      stopController.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      socket?.removeAllListeners();
      socket?.disconnect();
    },
    store,
  };
}
