import { expect, it, vi } from "vitest";

import { RedisStreamAdminEventSink } from "@/modules/admin/admin-outbox-dispatcher";

it("atomically deduplicates admin events into the production Redis stream", async () => {
  const evalCommand = vi.fn(async () => "123-0");
  const connect = vi.fn(async () => undefined);
  const sink = new RedisStreamAdminEventSink({ isOpen: false, connect, eval: evalCommand });
  await sink.publish({ eventId: "00000000-0000-4000-8000-000000000001",
    deduplicationKey: "00000000-0000-4000-8000-000000000001", eventType: "admin.manual_refund.executed",
    aggregateType: "payment", aggregateId: "00000000-0000-4000-8000-000000000002",
    requestId: "00000000-0000-4000-8000-000000000003", payload: { transition: { status: "executed" } },
    createdAt: "2026-08-14T12:00:00.000Z" });
  expect(connect).toHaveBeenCalledOnce();
  expect(evalCommand).toHaveBeenCalledWith(expect.stringContaining("XADD"), expect.objectContaining({
    keys: ["admin:governance:dedup:00000000-0000-4000-8000-000000000001", "admin:governance:events"],
    arguments: expect.arrayContaining(["00000000-0000-4000-8000-000000000001",
      "admin.manual_refund.executed"]),
  }));
  const script = String((evalCommand.mock.calls as unknown as Array<[string]>)[0]?.[0]);
  expect(script.indexOf("XADD")).toBeLessThan(script.indexOf("SET"));
});

it("rejects a non-durable Redis acknowledgement instead of marking the DB event delivered", async () => {
  const sink = new RedisStreamAdminEventSink({ isOpen: true, eval: vi.fn(async () => 0) });
  await expect(sink.publish({ eventId: "00000000-0000-4000-8000-000000000001",
    deduplicationKey: "00000000-0000-4000-8000-000000000001", eventType: "admin.manual_refund.executed",
    aggregateType: "payment", aggregateId: "00000000-0000-4000-8000-000000000002",
    requestId: "00000000-0000-4000-8000-000000000003", payload: {},
    createdAt: "2026-08-14T12:00:00.000Z" })).rejects.toThrow("ADMIN_EVENT_SINK_INVALID_ACK");
});
