import { describe, expect, it, vi } from "vitest";

import { DeletionService, DeletionWorker, deletionSchedule } from "@/modules/profiles/deletion-service";

describe("deletionSchedule", () => {
  it("uses a 30-day cooling period and preserves legal holds", () => {
    expect(deletionSchedule(new Date("2026-08-05T00:00:00Z"), true)).toEqual({
      executeAt: new Date("2026-09-04T00:00:00.000Z"),
      preserveHeldRecords: true,
    });
  });
});

describe("DeletionWorker", () => {
  it("retains held ledgers before anonymizing eligible data", async () => {
    const order: string[] = [];
    const worker = new DeletionWorker({
      claim: async () => ({ id: "delete-1", leaseId: "lease-1", userId: "owner", preserveHeldRecords: true, attempts: 1 }),
      retainRestricted: async () => { order.push("retain"); },
      anonymizeEligible: async () => { order.push("anonymize"); },
      complete: async () => { order.push("complete"); }, retry: vi.fn(), manualReview: vi.fn(),
    });
    await expect(worker.runOne()).resolves.toBe(true);
    expect(order).toEqual(["retain", "anonymize", "complete"]);
  });
});

describe("DeletionService", () => {
  it("registers immediate safety actions and a durable cooling-off workflow", async () => {
    const calls: string[] = [];
    const service = new DeletionService({
      begin: async (input) => { calls.push("begin"); return { requestId: "delete-1", ...input,
        cancellationToken: "c".repeat(43), replayed: false }; },
      revokeSessions: async () => { calls.push("sessions"); },
      hideProfile: async () => { calls.push("profile"); },
      enqueueRenewalCancellation: async () => { calls.push("renewal"); },
      enqueueNotification: async () => { calls.push("notification"); },
    });
    await expect(service.request({ userId: "user-1", idempotencyKey: "delete-request-0001",
      now: new Date("2026-08-05T00:00:00Z") })).resolves.toMatchObject({ requestId: "delete-1",
      status: "cooling_off", executeAt: new Date("2026-09-04T00:00:00Z") });
    expect(calls).toEqual(["begin", "sessions", "profile", "renewal"]);
  });

  it("cancels only an owned cooling-off request", async () => {
    const cancel = async (input: { token: string; idempotencyKey: string }) => ({ ...input, canceled: true });
    const service = new DeletionService({ begin: async () => { throw new Error("unused"); }, revokeSessions: async () => {},
      hideProfile: async () => {}, enqueueRenewalCancellation: async () => {}, enqueueNotification: async () => {}, cancel });
    await expect(service.cancel({ token: "c".repeat(43), idempotencyKey: "cancel-request-0001" }))
      .resolves.toEqual({ token: "c".repeat(43), idempotencyKey: "cancel-request-0001", canceled: true });
  });
});
