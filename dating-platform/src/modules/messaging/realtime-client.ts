"use client";

import { io, type Socket } from "socket.io-client";

export type RealtimeConnectionState = "connecting" | "online" | "retrying" | "failed";
export type MessageNotification = { eventId: string; messageId: string; conversationId: string; sequence: number };
export type RecoveredMessage = {
  id: string; conversationId: string; sequence: number; body: string; sender: "me" | "them"; createdAt: string;
};

class RealtimeActionError extends Error {
  constructor(readonly code: "RETRY_LATER" | "NOT_AVAILABLE", readonly retryAfterMs?: number) {
    super(code);
  }
}

export class RealtimeRecoveryError extends Error {
  constructor(readonly code: "NOT_AVAILABLE") { super(code); }
}

export const requireRealtimeRecoveryResponse = (response: { ok: boolean; status: number }) => {
  if (response.ok) return;
  if ([401, 403, 404].includes(response.status)) throw new RealtimeRecoveryError("NOT_AVAILABLE");
  throw new Error("RECOVERY_RETRY_LATER");
};

export class CoalescedRecovery {
  private readonly active = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  run(key: string, recover: () => Promise<void>) {
    const existing = this.active.get(key);
    if (existing) { existing.dirty = true; return existing.promise; }
    const state = { dirty: true, promise: Promise.resolve() };
    state.promise = (async () => {
      while (state.dirty) { state.dirty = false; await recover(); }
    })().finally(() => {
      if (this.active.get(key) === state) this.active.delete(key);
    });
    this.active.set(key, state);
    return state.promise;
  }
}

export class CoalescedAbortableRequests {
  private readonly active = new Map<string, {
    dirty: boolean;
    controller: AbortController;
    promise: Promise<void>;
  }>();

  run(key: string, request: (signal: AbortSignal) => Promise<void>) {
    const existing = this.active.get(key);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const state = { dirty: true, controller: new AbortController(), promise: Promise.resolve() };
    state.promise = (async () => {
      while (state.dirty && !state.controller.signal.aborted) {
        state.dirty = false;
        try {
          await request(state.controller.signal);
        } catch (error) {
          if (!state.controller.signal.aborted) throw error;
        }
      }
    })().finally(() => {
      if (this.active.get(key) === state) this.active.delete(key);
    });
    this.active.set(key, state);
    return state.promise;
  }

  cancel(key: string) {
    const state = this.active.get(key);
    if (!state) return;
    this.active.delete(key);
    state.controller.abort();
  }

  cancelAll() {
    const states = [...this.active.values()];
    this.active.clear();
    for (const state of states) state.controller.abort();
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

type ReceiptKind = "delivered" | "read";
type ReceiptSendResult = { ok: true } | {
  ok: false;
  code: "RETRY_LATER" | "NOT_AVAILABLE";
  retryAfterMs?: number;
};

export class ReceiptDeliveryQueue {
  private readonly pending = new Map<string, { kind: ReceiptKind; message: RecoveredMessage }>();
  private readonly completed = new Map<string, ReceiptKind>();
  private readonly permanentlyUnavailable = new Set<string>();
  private readonly controller = new AbortController();
  private readonly idleWaiters = new Set<() => void>();
  private processing = false;
  private scheduled = false;
  private stopped = false;

  constructor(private readonly options: {
    send(kind: ReceiptKind, message: RecoveredMessage, at: string, signal: AbortSignal): Promise<ReceiptSendResult>;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    clock?: () => Date;
    maxRetries?: number;
    maxPending?: number;
    onError?: (code: "RECEIPT_NOT_AVAILABLE" | "RECEIPT_RETRY_EXHAUSTED" | "RECEIPT_QUEUE_FULL") => void;
  }) {}

  enqueue(kind: ReceiptKind, message: RecoveredMessage) {
    if (this.stopped || message.sender !== "them" || this.permanentlyUnavailable.has(message.id)) return;
    const completed = this.completed.get(message.id);
    if (completed === "read" || (completed === "delivered" && kind === "delivered")) return;
    const current = this.pending.get(message.id);
    if (current) {
      if (kind === "read") current.kind = "read";
      return;
    }
    if (this.pending.size >= (this.options.maxPending ?? 5_000)) {
      this.options.onError?.("RECEIPT_QUEUE_FULL");
      return;
    }
    this.pending.set(message.id, { kind, message });
    this.schedule();
  }

  drain() {
    if (!this.processing && !this.scheduled && this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.pending.clear();
    this.controller.abort(new DOMException("Stopped", "AbortError"));
    if (!this.processing) this.resolveIdle();
  }

  private schedule() {
    if (this.scheduled || this.processing || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.process();
    });
  }

  private async process() {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      while (!this.stopped) {
        const entry = this.pending.entries().next().value as [string, { kind: ReceiptKind; message: RecoveredMessage }] | undefined;
        if (!entry) break;
        const [messageId, task] = entry;
        this.pending.delete(messageId);
        let attempts = 0;
        while (!this.stopped) {
          try {
            const result = await this.options.send(
              task.kind,
              task.message,
              (this.options.clock?.() ?? new Date()).toISOString(),
              this.controller.signal,
            );
            if (result.ok) {
              this.completed.set(messageId, task.kind);
              break;
            }
            if (result.code === "NOT_AVAILABLE") {
              this.permanentlyUnavailable.add(messageId);
              this.options.onError?.("RECEIPT_NOT_AVAILABLE");
              break;
            }
            attempts += 1;
            if (attempts > (this.options.maxRetries ?? 5)) {
              this.options.onError?.("RECEIPT_RETRY_EXHAUSTED");
              break;
            }
            await (this.options.sleep ?? abortableDelay)(
              result.retryAfterMs ?? Math.min(250 * 2 ** (attempts - 1), 60_000),
              this.controller.signal,
            );
          } catch {
            if (this.stopped || this.controller.signal.aborted) break;
            attempts += 1;
            if (attempts > (this.options.maxRetries ?? 5)) {
              this.options.onError?.("RECEIPT_RETRY_EXHAUSTED");
              break;
            }
            await (this.options.sleep ?? abortableDelay)(
              Math.min(250 * 2 ** (attempts - 1), 60_000),
              this.controller.signal,
            );
          }
        }
      }
    } finally {
      this.processing = false;
      if (!this.stopped && this.pending.size > 0) this.schedule();
      else this.resolveIdle();
    }
  }

  private resolveIdle() {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export const abortableDelay = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const onAbort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  timer.unref?.();
  signal.addEventListener("abort", onAbort, { once: true });
});

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
  onBackgroundError?: (code: "RECEIPT_NOT_AVAILABLE" | "RECEIPT_RETRY_EXHAUSTED" | "RECEIPT_QUEUE_FULL") => void;
}) {
  const store = new RealtimeMessageStore();
  const conversations = new Set<string>();
  let socket: Socket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let stopped = false;
  let started = false;
  let connecting = false;
  let terminalJoinFailure = false;
  const authorizedConversationIds = new Set<string>();
  const deferredReceipts = new Map<string, { kind: ReceiptKind; message: RecoveredMessage }>();
  const stopController = new AbortController();
  const recoveryCoordinator = new CoalescedRecovery();

  const emitAck = async (event: string, payload: Record<string, unknown>) => {
    if (!socket?.connected) throw new Error("REALTIME_NOT_CONNECTED");
    let ack: unknown;
    try {
      ack = await socket.timeout(options.ackTimeoutMs ?? 5_000).emitWithAck(event, payload) as unknown;
    } catch {
      throw new RealtimeActionError("RETRY_LATER");
    }
    if (!ack || typeof ack !== "object" || (ack as { ok?: unknown }).ok !== true) {
      const rejected = ack as { code?: unknown; retryAfterMs?: unknown };
      const code = rejected.code === "RETRY_LATER" ? "RETRY_LATER" : "NOT_AVAILABLE";
      const retryAfterMs = typeof rejected.retryAfterMs === "number"
        ? Math.min(Math.max(rejected.retryAfterMs, 0), 60_000)
        : undefined;
      throw new RealtimeActionError(code, retryAfterMs);
    }
    return ack;
  };

  const receiptQueue = new ReceiptDeliveryQueue({
    send: async (kind, message, at) => {
      if (!authorizedConversationIds.has(message.conversationId)) {
        return { ok: false, code: "RETRY_LATER", retryAfterMs: 250 };
      }
      try {
        await emitAck("receipt.update", {
          conversationId: message.conversationId,
          messageId: message.id,
          kind,
          at,
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof RealtimeActionError) {
          return { ok: false, code: error.code, retryAfterMs: error.retryAfterMs };
        }
        return { ok: false, code: "RETRY_LATER" };
      }
    },
    onError: options.onBackgroundError,
  });
  const queueReceipt = (kind: ReceiptKind, message: RecoveredMessage) => {
    if (message.sender !== "them") return;
    if (authorizedConversationIds.has(message.conversationId)) {
      receiptQueue.enqueue(kind, message);
      return;
    }
    const current = deferredReceipts.get(message.id);
    if (!current || kind === "read") deferredReceipts.set(message.id, { kind, message });
  };
  const queueAuthorizedConversationReceipts = (conversationId: string) => {
    for (const message of store.messages(conversationId)) receiptQueue.enqueue("delivered", message);
    for (const [messageId, receipt] of deferredReceipts) {
      if (receipt.message.conversationId !== conversationId) continue;
      receiptQueue.enqueue(receipt.kind, receipt.message);
      deferredReceipts.delete(messageId);
    }
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
        if (authorizedConversationIds.has(conversationId)) {
          for (const message of rows) queueReceipt("delivered", message);
        }
    });
  };
  const recoveryError = (error: unknown) => error instanceof RealtimeRecoveryError
    ? new RealtimeActionError("NOT_AVAILABLE")
    : new RealtimeActionError("RETRY_LATER");
  const recoverWithBudget = async (conversationId: string) => {
    let attempts = 0;
    while (!stopped) {
      try {
        await recover(conversationId);
        if (started && !socket?.connected) options.onState("failed");
        return;
      } catch (error) {
        if (stopped) return;
        const actionError = recoveryError(error);
        if (actionError.code === "NOT_AVAILABLE") {
          terminalJoinFailure = true;
          socket?.disconnect();
          options.onState("failed");
          throw actionError;
        }
        attempts += 1;
        if (attempts > (options.maxRetries ?? 8)) {
          terminalJoinFailure = true;
          socket?.disconnect();
          options.onState("failed");
          throw actionError;
        }
        options.onState("retrying");
        try {
          await abortableDelay(Math.min(100 * 2 ** (attempts - 1), 2_000), stopController.signal);
        } catch {
          if (stopped || stopController.signal.aborted) return;
          throw actionError;
        }
      }
    }
  };
  const joinAndRecover = async (conversationId: string) => {
    await emitAck("conversation.join", { conversationId });
    authorizedConversationIds.add(conversationId);
    queueAuthorizedConversationReceipts(conversationId);
    await recover(conversationId);
  };
  const joinWithBudget = async (conversationId: string) => {
    let attempts = 0;
    while (!stopped && socket?.connected) {
      try {
        await joinAndRecover(conversationId);
        terminalJoinFailure = false;
        retries = 0;
        options.onState("online");
        return;
      } catch (error) {
        if (stopped) return;
        const actionError = error instanceof RealtimeActionError
          ? error
          : recoveryError(error);
        if (actionError.code === "NOT_AVAILABLE") {
          terminalJoinFailure = true;
          authorizedConversationIds.clear();
          socket?.disconnect();
          options.onState("failed");
          throw actionError;
        }
        attempts += 1;
        if (attempts > (options.maxRetries ?? 8)) {
          terminalJoinFailure = true;
          authorizedConversationIds.clear();
          socket?.disconnect();
          options.onState("failed");
          throw actionError;
        }
        options.onState("retrying");
        try {
          await abortableDelay(
            actionError.retryAfterMs ?? Math.min(100 * 2 ** (attempts - 1), 2_000),
            stopController.signal,
          );
        } catch {
          if (stopped || stopController.signal.aborted) return;
          throw actionError;
        }
      }
    }
    if (stopped) return;
    throw new RealtimeActionError("RETRY_LATER");
  };
  const schedule = () => {
    if (terminalJoinFailure) return options.onState("failed");
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
    if (terminalJoinFailure) return options.onState("failed");
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
            await joinWithBudget(conversationId);
          }
          retries = 0;
          if (conversations.size === 0) options.onState("online");
        } catch { if (!terminalJoinFailure) socket?.disconnect(); }
      });
      socket.on("message.created", async (event: MessageNotification) => {
        try {
          if (store.mergeLive(event)) await recover(event.conversationId);
        } catch { socket?.disconnect(); }
      });
      socket.on("disconnect", () => {
        authorizedConversationIds.clear();
        schedule();
      });
      socket.on("connect_error", schedule);
      if (refreshTimer) clearTimeout(refreshTimer);
      const refreshIn = Math.max(Date.parse(ticket.expiresAt) - Date.now() - 30_000, 1_000);
      refreshTimer = setTimeout(() => { socket?.disconnect(); }, refreshIn);
    } catch { schedule(); } finally { connecting = false; }
  };
  return {
    async start() {
      started = true;
      await connect();
    },
    async join(conversationId: string) {
      conversations.add(conversationId);
      if (socket?.connected) {
        terminalJoinFailure = false;
        await joinWithBudget(conversationId);
      } else await recoverWithBudget(conversationId);
    },
    async markDelivered(message: RecoveredMessage) {
      queueReceipt("delivered", message);
    },
    async markRead(message: RecoveredMessage) {
      queueReceipt("read", message);
    },
    async refresh(conversationId: string) {
      if (!conversations.has(conversationId)) conversations.add(conversationId);
      await recoverWithBudget(conversationId);
    },
    stop() {
      stopped = true;
      stopController.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      receiptQueue.stop();
      socket?.removeAllListeners();
      socket?.disconnect();
    },
    store,
  };
}
