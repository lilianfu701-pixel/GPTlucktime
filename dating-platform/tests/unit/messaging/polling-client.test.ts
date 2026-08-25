// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPollingMessageClient } from "@/modules/messaging/polling-client";
import type { RecoveredMessage } from "@/modules/messaging/realtime-client";

const conversationId = "00000000-0000-4000-8000-000000000001";

const inbound = (sequence: number): RecoveredMessage => ({
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  conversationId,
  sequence,
  body: `message ${sequence}`,
  sender: "them",
  createdAt: "2026-08-24T12:00:00.000Z",
});

const setVisibility = (value: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

describe("HTTP polling message client", () => {
  it("recovers immediately on join and once every 2,000 ms while visible", async () => {
    vi.useFakeTimers();
    const cursors: number[] = [];
    const client = createPollingMessageClient({
      recover: async (_id, afterSequence) => {
        cursors.push(afterSequence);
        return afterSequence === 0 ? [inbound(1)] : [];
      },
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages: () => undefined,
    });

    await client.start();
    await client.join(conversationId);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(cursors).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cursors).toEqual([0, 1]);
    client.stop();
  });

  it("switches polling to the latest joined conversation and keeps old failures from changing active state", async () => {
    vi.useFakeTimers();
    const first = "00000000-0000-4000-8000-000000000011";
    const second = "00000000-0000-4000-8000-000000000012";
    const states: string[] = [];
    let rejectFirst!: (error: Error) => void;
    const oldRecovery = new Promise<RecoveredMessage[]>((_resolve, reject) => { rejectFirst = reject; });
    const calls: string[] = [];
    const client = createPollingMessageClient({
      recover: async (id) => {
        calls.push(id);
        return id === first ? oldRecovery : [];
      },
      sendReceipt: async () => ({ ok: true }),
      onState: (state) => states.push(state),
      onMessages: () => undefined,
      maxRetries: 0,
    });

    await client.start();
    const joiningFirst = client.join(first);
    await vi.advanceTimersByTimeAsync(0);
    await client.join(second);
    rejectFirst(new Error("old conversation failed"));
    await joiningFirst;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual([first, second, second]);
    expect(states.at(-1)).toBe("online");
    client.stop();
  });

  it("never overlaps a slow recovery for one conversation", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const client = createPollingMessageClient({
      recover: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 1) await gate;
        active -= 1;
        return [];
      },
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages: () => undefined,
    });

    await client.start();
    const joining = client.join(conversationId);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(1);
    release();
    await joining;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
    client.stop();
  });

  it("runs one coalesced recovery after join or refresh arrives during an active recovery", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const firstRecovery = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const client = createPollingMessageClient({
      recover: async () => {
        calls += 1;
        if (calls === 1) await firstRecovery;
        return [];
      },
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages: () => undefined,
    });

    await client.start();
    const firstJoin = client.join(conversationId);
    await vi.advanceTimersByTimeAsync(0);
    const refresh = client.refresh(conversationId);
    const repeatedJoin = client.join(conversationId);
    release();
    await Promise.all([firstJoin, refresh, repeatedJoin]);
    expect(calls).toBe(2);
    client.stop();
  });

  it("runs a dirty follow-up recovery after the active round rejects", async () => {
    vi.useFakeTimers();
    let rejectFirst!: (error: Error) => void;
    const firstRecovery = new Promise<RecoveredMessage[]>((_resolve, reject) => { rejectFirst = reject; });
    let calls = 0;
    const client = createPollingMessageClient({
      recover: async () => {
        calls += 1;
        return calls === 1 ? firstRecovery : [];
      },
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages: () => undefined,
      maxRetries: 0,
    });

    await client.start();
    const joining = client.join(conversationId);
    await vi.advanceTimersByTimeAsync(0);
    const refreshing = client.refresh(conversationId);
    rejectFirst(new Error("first round failed"));
    await Promise.all([joining, refreshing]);
    expect(calls).toBe(2);
    client.stop();
  });

  it("pauses hidden polling and catches up immediately when visible", async () => {
    vi.useFakeTimers();
    let visibility: "visible" | "hidden" = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const recover = vi.fn(async () => []);
    const client = createPollingMessageClient({
      recover,
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages: () => undefined,
    });

    await client.start();
    await client.join(conversationId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("uses bounded exponential retries before reporting failure", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const recover = vi.fn(async () => { throw new Error("offline"); });
    const client = createPollingMessageClient({
      recover,
      sendReceipt: async () => ({ ok: true }),
      onState: (state) => states.push(state),
      onMessages: () => undefined,
      maxRetries: 2,
    });

    await client.start();
    const joining = client.join(conversationId);
    const rejected = expect(joining).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(recover).toHaveBeenCalledTimes(3);
    expect(states).toEqual(["connecting", "retrying", "retrying", "failed"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).toHaveBeenCalledTimes(3);
    client.stop();
  });

  it("pauses retry backoff while hidden and catches up when visible again", async () => {
    vi.useFakeTimers();
    let visibility: "visible" | "hidden" = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const recover = vi.fn(async () => { throw new Error("offline"); });
    const client = createPollingMessageClient({
      recover,
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages: () => undefined,
      maxRetries: 2,
    });

    await client.start();
    const joining = client.join(conversationId);
    await vi.advanceTimersByTimeAsync(0);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await joining;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).toHaveBeenCalledTimes(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it("writes delivered and read receipts through the injected authorized transport", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const client = createPollingMessageClient({
      recover: async () => [inbound(1)],
      sendReceipt: async (kind, message) => {
        sent.push(`${kind}:${message.id}`);
        return { ok: true };
      },
      onState: () => undefined,
      onMessages: () => undefined,
    });

    await client.start();
    await client.join(conversationId);
    await vi.advanceTimersByTimeAsync(0);
    await client.markRead(inbound(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([`delivered:${inbound(1).id}`, `read:${inbound(1).id}`]);
    client.stop();
  });

  it("does not notify consumers for empty recovery polls", async () => {
    vi.useFakeTimers();
    const onMessages = vi.fn();
    const client = createPollingMessageClient({
      recover: async () => [],
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages,
    });

    await client.start();
    await client.join(conversationId);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onMessages).not.toHaveBeenCalled();
    client.stop();
  });

  it("aborts active work and prevents later callbacks when stopped", async () => {
    vi.useFakeTimers();
    let recoveredSignal: AbortSignal | undefined;
    let callbacks = 0;
    const client = createPollingMessageClient({
      recover: async (_id, _after, signal) => {
        recoveredSignal = signal;
        await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return [inbound(1)];
      },
      sendReceipt: async () => ({ ok: true }),
      onState: () => { callbacks += 1; },
      onMessages: () => { callbacks += 1; },
    });

    await client.start();
    const joining = client.join(conversationId);
    await vi.advanceTimersByTimeAsync(0);
    const beforeStop = callbacks;
    client.stop();
    await joining;
    expect(recoveredSignal?.aborted).toBe(true);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callbacks).toBe(beforeStop);
  });

  it("cancels retry backoff cleanly when stopped", async () => {
    vi.useFakeTimers();
    const client = createPollingMessageClient({
      recover: async () => { throw new Error("temporarily offline"); },
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages: () => undefined,
    });

    await client.start();
    const joining = client.join(conversationId);
    const settled = joining.then(() => "fulfilled", () => "rejected");
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    expect(await settled).toBe("fulfilled");
  });

  it("refreshes immediately and coalesces concurrent refreshes into one post-active round", async () => {
    vi.useFakeTimers();
    const cursors: number[] = [];
    const client = createPollingMessageClient({
      recover: async (_id, afterSequence) => { cursors.push(afterSequence); return []; },
      sendReceipt: async () => ({ ok: true }),
      onState: () => undefined,
      onMessages: () => undefined,
    });

    await client.start();
    await client.join(conversationId);
    await Promise.all([client.refresh(conversationId), client.refresh(conversationId)]);
    expect(cursors).toEqual([0, 0, 0]);
    client.stop();
  });
});
