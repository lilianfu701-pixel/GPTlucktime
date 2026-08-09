// @vitest-environment node

import { describe, expect, it } from "vitest";

import { recoverAllMessagePages, RealtimeMessageStore } from "@/modules/messaging/realtime-client";

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
