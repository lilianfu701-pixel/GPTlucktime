// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  CoalescedRecovery,
  PendingSendLedger,
  RequestGenerations,
  recoverAllMessagePages,
  RealtimeMessageStore,
} from "@/modules/messaging/realtime-client";

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
