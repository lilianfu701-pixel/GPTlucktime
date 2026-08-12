// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  DeliverySuppressedError,
  MessageOutboxConsumer,
  type ClaimedMessageEvent,
  type MessageOutboxStore,
} from "../../../realtime/outbox-consumer";

const event: ClaimedMessageEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  leaseId: "00000000-0000-4000-8000-000000000002",
  attempts: 1,
  payload: {
    messageId: "00000000-0000-4000-8000-000000000003",
    conversationId: "00000000-0000-4000-8000-000000000004",
    senderUserId: "00000000-0000-4000-8000-000000000005",
    sequence: 7,
  },
};

describe("message outbox consumer", () => {
  it("publishes a bounded claimed batch and completes by lease CAS", async () => {
    const completed: string[] = [];
    const store: MessageOutboxStore = {
      claim: vi.fn(async (limit) => (expect(limit).toBe(20), [event])),
      markPublished: async (id) => { completed.push(id); return true; },
      reschedule: vi.fn(),
      suppress: vi.fn(),
      failInvalid: vi.fn(),
    };
    const publish = vi.fn(async () => undefined);
    await new MessageOutboxConsumer(store, publish).runOnce();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventId: event.id, sequence: 7 }));
    expect(completed).toEqual([event.id]);
  });

  it("uses finite exponential retry and leaves failed events stable", async () => {
    const retried: Array<{ failed: boolean; delayMs: number }> = [];
    const store: MessageOutboxStore = {
      claim: async () => [{ ...event, attempts: 5 }],
      markPublished: vi.fn(),
      reschedule: async (_id, _leaseId, update) => { retried.push(update); return true; },
      suppress: vi.fn(),
      failInvalid: vi.fn(),
    };
    await new MessageOutboxConsumer(store, async () => { throw new Error("transport unavailable"); }, {
      maxAttempts: 5,
      baseBackoffMs: 100,
    }).runOnce();
    expect(retried).toEqual([{ failed: true, delayMs: 0 }]);
  });

  it("suppresses a permanently unauthorized event instead of retrying or failing it", async () => {
    const suppressed: Array<{ id: string; reason: string }> = [];
    const store: MessageOutboxStore = {
      claim: async () => [event],
      markPublished: vi.fn(),
      reschedule: vi.fn(),
      suppress: async (id, _leaseId, reason) => { suppressed.push({ id, reason }); return true; },
      failInvalid: vi.fn(),
    };
    await new MessageOutboxConsumer(store, async () => {
      throw new DeliverySuppressedError("MODERATION_RESTRICTED");
    }).runOnce();
    expect(suppressed).toEqual([{ id: event.id, reason: "MODERATION_RESTRICTED" }]);
    expect(store.reschedule).not.toHaveBeenCalled();
  });

  it("permanently fails a malformed claimed payload without publishing it", async () => {
    const invalid: string[] = [];
    const store: MessageOutboxStore = {
      claim: async () => [{ ...event, payload: { ...event.payload, sequence: 0 } }],
      markPublished: vi.fn(),
      suppress: vi.fn(),
      reschedule: vi.fn(),
      failInvalid: async (id) => { invalid.push(id); return true; },
    };
    const publish = vi.fn();
    await new MessageOutboxConsumer(store, publish).runOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(invalid).toEqual([event.id]);
    expect(store.reschedule).not.toHaveBeenCalled();
  });
});
