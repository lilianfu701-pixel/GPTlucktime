import {
  abortableDelay,
  CoalescedAbortableRequests,
  ReceiptDeliveryQueue,
  RealtimeMessageStore,
  RealtimeRecoveryError,
  type RealtimeConnectionState,
  type RecoveredMessage,
} from "./realtime-client";

type ReceiptKind = "delivered" | "read";
type ReceiptResult = { ok: true } | {
  ok: false;
  code: "RETRY_LATER" | "NOT_AVAILABLE";
  retryAfterMs?: number;
};

export type PollingMessageClientOptions = {
  intervalMs?: number;
  maxRetries?: number;
  recover(conversationId: string, afterSequence: number, signal?: AbortSignal): Promise<RecoveredMessage[]>;
  sendReceipt(kind: ReceiptKind, message: RecoveredMessage, at: string, signal: AbortSignal): Promise<ReceiptResult>;
  onState(state: RealtimeConnectionState): void;
  onMessages(conversationId: string, messages: RecoveredMessage[]): void;
  onBackgroundError?: (code: "RECEIPT_NOT_AVAILABLE" | "RECEIPT_RETRY_EXHAUSTED" | "RECEIPT_QUEUE_FULL") => void;
};

export type PollingMessageClient = {
  start(): Promise<void>;
  join(conversationId: string): Promise<void>;
  refresh(conversationId: string): Promise<void>;
  markDelivered(message: RecoveredMessage): Promise<void>;
  markRead(message: RecoveredMessage): Promise<void>;
  stop(): void;
  store: RealtimeMessageStore;
};

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

export function createPollingMessageClient(options: PollingMessageClientOptions): PollingMessageClient {
  const intervalMs = options.intervalMs ?? 2_000;
  const maxRetries = options.maxRetries ?? 8;
  const store = new RealtimeMessageStore();
  const recoveryRequests = new CoalescedAbortableRequests();
  const retryDelays = new Map<string, Set<AbortController>>();
  const controller = new AbortController();
  const receiptQueue = new ReceiptDeliveryQueue({ send: options.sendReceipt, onError: options.onBackgroundError });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let stopped = false;
  let activeConversationId: string | undefined;
  let activeRecovery: { conversationId: string; dirty: boolean; promise: Promise<void> } | undefined;
  let activeFailed = false;
  let hiddenGeneration = 0;

  const emitState = (conversationId: string, state: RealtimeConnectionState) => {
    if (!stopped && activeConversationId === conversationId) options.onState(state);
  };

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const recoverOnce = (conversationId: string) => recoveryRequests.run(conversationId, async (signal) => {
    const before = store.messages(conversationId);
    const recovered = await options.recover(conversationId, store.lastSequence(conversationId), signal);
    if (stopped || signal.aborted || activeConversationId !== conversationId) return;
    store.mergeRecovery(conversationId, recovered);
    for (const message of recovered) {
      if (message.sender === "them") receiptQueue.enqueue("delivered", message);
    }
    const hydrated = store.messages(conversationId);
    if (hydrated.length > before.length && !stopped && activeConversationId === conversationId) {
      options.onMessages(conversationId, hydrated);
    }
  });

  const abortRetryDelays = (conversationId?: string) => {
    const entries = conversationId ? [retryDelays.get(conversationId)] : [...retryDelays.values()];
    for (const delays of entries) {
      for (const delay of delays ?? []) delay.abort(new DOMException("Polling hidden", "AbortError"));
    }
  };

  const waitForRetry = async (conversationId: string, milliseconds: number) => {
    const delay = new AbortController();
    const abortOnStop = () => delay.abort(controller.signal.reason);
    const delays = retryDelays.get(conversationId) ?? new Set<AbortController>();
    retryDelays.set(conversationId, delays);
    delays.add(delay);
    controller.signal.addEventListener("abort", abortOnStop, { once: true });
    try {
      await abortableDelay(milliseconds, delay.signal);
    } finally {
      delays.delete(delay);
      if (delays.size === 0) retryDelays.delete(conversationId);
      controller.signal.removeEventListener("abort", abortOnStop);
    }
  };

  const recoverRoundWithBudget = async (conversationId: string, state: NonNullable<typeof activeRecovery>) => {
    let retries = 0;
    while (!stopped && isVisible() && activeConversationId === conversationId && activeRecovery === state) {
      try {
        await recoverOnce(conversationId);
        if (stopped || activeConversationId !== conversationId || activeRecovery !== state) return;
        activeFailed = false;
        emitState(conversationId, "online");
        return;
      } catch (error) {
        if (stopped || controller.signal.aborted || !isVisible()
          || activeConversationId !== conversationId || activeRecovery !== state) return;
        if (error instanceof RealtimeRecoveryError) {
          activeFailed = true;
          emitState(conversationId, "failed");
          clearTimer();
          throw error;
        }
        retries += 1;
        if (retries > maxRetries) {
          activeFailed = true;
          emitState(conversationId, "failed");
          clearTimer();
          throw error;
        }
        emitState(conversationId, "retrying");
        const generationBeforeDelay = hiddenGeneration;
        try {
          await waitForRetry(conversationId, Math.min(100 * 2 ** (retries - 1), 2_000));
        } catch {
          if (stopped || controller.signal.aborted || !isVisible() || hiddenGeneration !== generationBeforeDelay
            || activeConversationId !== conversationId || activeRecovery !== state) return;
          throw error;
        }
      }
    }
  };

  const switchConversation = (conversationId: string) => {
    if (activeConversationId === conversationId) return;
    const previous = activeConversationId;
    activeConversationId = conversationId;
    activeFailed = false;
    if (previous) {
      recoveryRequests.cancel(previous);
      abortRetryDelays(previous);
    }
  };

  const recoverWithBudget = (conversationId: string) => {
    if (activeConversationId !== conversationId) switchConversation(conversationId);
    if (activeRecovery?.conversationId === conversationId) {
      activeRecovery.dirty = true;
      return activeRecovery.promise;
    }
    const state: NonNullable<typeof activeRecovery> = { conversationId, dirty: false, promise: Promise.resolve() };
    activeRecovery = state;
    state.promise = (async () => {
      do {
        state.dirty = false;
        try {
          await recoverRoundWithBudget(conversationId, state);
        } catch (error) {
          if (!state.dirty || stopped || activeConversationId !== conversationId || activeRecovery !== state) throw error;
        }
      } while (!stopped && isVisible() && activeConversationId === conversationId && activeRecovery === state && state.dirty);
    })().finally(() => {
      if (activeRecovery === state) activeRecovery = undefined;
    });
    return state.promise;
  };

  const schedule = () => {
    if (stopped || activeFailed || !started || !isVisible() || timer || !activeConversationId) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll().catch(() => undefined);
    }, intervalMs);
  };

  const poll = async () => {
    const conversationId = activeConversationId;
    if (stopped || activeFailed || !started || !isVisible() || !conversationId) return;
    await recoverWithBudget(conversationId).catch(() => undefined);
    if (!stopped && !activeFailed && isVisible() && activeConversationId === conversationId) schedule();
  };

  const onVisibilityChange = () => {
    if (stopped || !started) return;
    if (!isVisible()) {
      hiddenGeneration += 1;
      clearTimer();
      abortRetryDelays();
      return;
    }
    activeFailed = false;
    clearTimer();
    void poll().catch(() => undefined);
  };

  return {
    async start() {
      if (stopped || started) return;
      started = true;
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
      if (!isVisible()) return;
      if (activeConversationId) {
        emitState(activeConversationId, "connecting");
        await poll();
      }
    },
    async join(conversationId) {
      if (stopped) return;
      switchConversation(conversationId);
      if (!isVisible()) return;
      clearTimer();
      if (activeRecovery?.conversationId !== conversationId) emitState(conversationId, "connecting");
      await recoverWithBudget(conversationId);
      if (!stopped && !activeFailed && started) schedule();
    },
    async refresh(conversationId) {
      if (stopped) return;
      switchConversation(conversationId);
      if (!isVisible()) return;
      activeFailed = false;
      clearTimer();
      if (activeRecovery?.conversationId !== conversationId) emitState(conversationId, "connecting");
      await recoverWithBudget(conversationId);
      if (!stopped && !activeFailed && started) schedule();
    },
    async markDelivered(message) {
      receiptQueue.enqueue("delivered", message);
    },
    async markRead(message) {
      receiptQueue.enqueue("read", message);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer();
      controller.abort(new DOMException("Stopped", "AbortError"));
      abortRetryDelays();
      recoveryRequests.cancelAll();
      receiptQueue.stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    },
    store,
  };
}
