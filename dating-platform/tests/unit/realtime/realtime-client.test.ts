// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  abortableDelay,
  CoalescedRecovery,
  CoalescedAbortableRequests,
  PendingSendLedger,
  RequestGenerations,
  requireRealtimeRecoveryResponse,
  recoverAllMessagePages,
  ReceiptDeliveryQueue,
  RealtimeMessageStore,
  type RecoveredMessage,
} from "@/modules/messaging/realtime-client";

const receiptMessage = (sequence: number): RecoveredMessage => ({
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  conversationId: "00000000-0000-4000-8000-000000000001",
  sequence,
  body: String(sequence),
  sender: "them",
  createdAt: "2026-08-08T12:00:00.000Z",
});

describe("realtime message store", () => {
  it("does not advance the recovery cursor until a notification has been hydrated from HTTP", () => {
    const store = new RealtimeMessageStore();
    const conversationId = "00000000-0000-4000-8000-000000000001";
    store.mergeLive({
      eventId: "00000000-0000-4000-8000-000000000002",
      messageId: "00000000-0000-4000-8000-000000000003",
      conversationId,
      sequence: 2,
    });
    expect(store.lastSequence(conversationId)).toBe(0);
    store.mergeRecovery(conversationId, [{
      id: "00000000-0000-4000-8000-000000000003",
      conversationId,
      sequence: 2,
      body: "recovered",
      sender: "them",
      createdAt: "2026-08-08T12:00:00.000Z",
    }]);
    expect(store.lastSequence(conversationId)).toBe(2);
  });
});

it("runs one additional recovery when a notification arrives during an active request", async () => {
  const coordinator = new CoalescedRecovery();
  let releaseFirst!: () => void;
  const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const recover = async () => {
    calls += 1;
    if (calls === 1) await firstBarrier;
  };

  const first = coordinator.run("conversation", recover);
  await Promise.resolve();
  const lateNotification = coordinator.run("conversation", recover);
  releaseFirst();
  await Promise.all([first, lateNotification]);

  expect(calls).toBe(2);
});

it("keeps the same client id after an uncertain send response", () => {
  const values = new Map<string, string>();
  const ledger = new PendingSendLedger({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });

  const first = ledger.prepare("conversation", "still send this");
  const retry = ledger.prepare("conversation", "still send this");
  expect(retry).toEqual(first);

  ledger.clear("conversation", "not-the-current-client-id");
  expect(ledger.prepare("conversation", "still send this")).toEqual(first);
  ledger.clear("conversation", first.clientId);
  expect(ledger.prepare("conversation", "still send this").clientId).not.toBe(first.clientId);
});

it("prevents a late request generation from replacing newer conversation state", () => {
  const generations = new RequestGenerations();
  const slow = generations.begin("conversation");
  const fast = generations.begin("conversation");
  expect(generations.isCurrent("conversation", fast)).toBe(true);
  expect(generations.isCurrent("conversation", slow)).toBe(false);
});

describe("durable receipt delivery queue", () => {
  it("coalesces delivered into read before sending", async () => {
    const sent: string[] = [];
    const queue = new ReceiptDeliveryQueue({
      send: async (kind) => { sent.push(kind); return { ok: true }; },
    });
    queue.enqueue("delivered", receiptMessage(1));
    queue.enqueue("read", receiptMessage(1));
    await queue.drain();
    expect(sent).toEqual(["read"]);
  });

  it("retries RETRY_LATER with bounded backoff and then succeeds", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const queue = new ReceiptDeliveryQueue({
      send: async () => (++attempts === 1
        ? { ok: false, code: "RETRY_LATER", retryAfterMs: 75 }
        : { ok: true }),
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    queue.enqueue("delivered", receiptMessage(1));
    await queue.drain();
    expect(attempts).toBe(2);
    expect(delays).toEqual([75]);
  });

  it("processes more than 100 messages with bounded concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const sent: string[] = [];
    const queue = new ReceiptDeliveryQueue({
      send: async (_kind, message) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        sent.push(message.id);
        active -= 1;
        return { ok: true };
      },
    });
    for (let sequence = 1; sequence <= 205; sequence += 1) {
      queue.enqueue("delivered", receiptMessage(sequence));
    }
    await queue.drain();
    expect(sent).toHaveLength(205);
    expect(new Set(sent).size).toBe(205);
    expect(maximumActive).toBe(1);
  });

  it("cancels active and queued work on stop", async () => {
    let attempts = 0;
    const queue = new ReceiptDeliveryQueue({
      send: async (_kind, _message, _at, signal) => {
        attempts += 1;
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return { ok: true };
      },
    });
    queue.enqueue("delivered", receiptMessage(1));
    queue.enqueue("delivered", receiptMessage(2));
    await Promise.resolve();
    queue.stop();
    await queue.drain();
    expect(attempts).toBe(1);
  });

  it("does not retry a permanently unavailable receipt after it is re-enqueued", async () => {
    let attempts = 0;
    const errors: string[] = [];
    const queue = new ReceiptDeliveryQueue({
      send: async () => { attempts += 1; return { ok: false, code: "NOT_AVAILABLE" }; },
      onError: (code) => errors.push(code),
    });
    queue.enqueue("delivered", receiptMessage(1));
    await queue.drain();
    queue.enqueue("read", receiptMessage(1));
    await queue.drain();
    expect(attempts).toBe(1);
    expect(errors).toEqual(["RECEIPT_NOT_AVAILABLE"]);
  });
});

it("coalesces dense receipt refresh requests and cancels them on cleanup", async () => {
  const requests = new CoalescedAbortableRequests();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const signals: AbortSignal[] = [];
  let calls = 0;
  const fetchPages = async (signal: AbortSignal) => {
    calls += 1;
    signals.push(signal);
    if (calls === 1) await barrier;
  };

  const first = requests.run("conversation", fetchPages);
  await Promise.resolve();
  const second = requests.run("conversation", fetchPages);
  const third = requests.run("conversation", fetchPages);
  release();
  await Promise.all([first, second, third]);
  expect(calls).toBe(2);

  const active = requests.run("other", async (signal) => {
    signals.push(signal);
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  await Promise.resolve();
  const cancelledSignal = signals.at(-1);
  requests.cancelAll();
  let replacementCalls = 0;
  const replacement = requests.run("other", async (signal) => {
    replacementCalls += 1;
    expect(signal.aborted).toBe(false);
  });
  await Promise.all([active, replacement]);
  expect(cancelledSignal?.aborted).toBe(true);
  expect(replacementCalls).toBe(1);
});

it("keeps a replacement request registered when a cancelled predecessor finally settles", async () => {
  const requests = new CoalescedAbortableRequests();
  let finishOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { finishOld = resolve; });
  const old = requests.run("same", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await oldGate;
  });
  await Promise.resolve();
  requests.cancel("same");

  let replacementSignal: AbortSignal | undefined;
  const replacement = requests.run("same", async (signal) => {
    replacementSignal = signal;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  await Promise.resolve();
  finishOld();
  await old;

  let unexpectedThirdCalls = 0;
  const third = requests.run("same", async () => { unexpectedThirdCalls += 1; });
  expect(third).toBe(replacement);
  requests.cancelAll();
  await Promise.all([replacement, third]);
  expect(replacementSignal?.aborted).toBe(true);
  expect(unexpectedThirdCalls).toBe(0);
});

it("removes the abort listener after a delay completes normally", async () => {
  class TrackingSignal extends EventTarget {
    aborted = false;
    reason: unknown;
    listeners = 0;
    override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
      this.listeners += 1;
      return super.addEventListener(...args);
    }
    override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
      this.listeners -= 1;
      return super.removeEventListener(...args);
    }
  }
  const signal = new TrackingSignal();
  await abortableDelay(0, signal as unknown as AbortSignal);
  expect(signal.listeners).toBe(0);
});

it("continues after each bounded recovery round until every page is hydrated", async () => {
  const calls: number[] = [];
  const rows = await recoverAllMessagePages(async (afterSequence) => {
    calls.push(afterSequence);
    const next = afterSequence + 1;
    return {
      messages: [{
        id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
        conversationId: "00000000-0000-4000-8000-000000000001",
        sequence: next,
        body: String(next),
        sender: "them" as const,
        createdAt: "2026-08-08T12:00:00.000Z",
      }],
      nextAfterSequence: next < 5 ? next : null,
    };
  }, { afterSequence: 0, maxPagesPerRound: 2, yieldToEventLoop: async () => undefined });
  expect(calls).toEqual([0, 1, 2, 3, 4]);
  expect(rows.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
});

it("classifies only explicit HTTP authorization failures as permanently unavailable", () => {
  expect(() => requireRealtimeRecoveryResponse({ ok: false, status: 404 })).toThrow("NOT_AVAILABLE");
  expect(() => requireRealtimeRecoveryResponse({ ok: false, status: 500 })).toThrow("RECOVERY_RETRY_LATER");
  expect(() => requireRealtimeRecoveryResponse({ ok: true, status: 200 })).not.toThrow();
});
