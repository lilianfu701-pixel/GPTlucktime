import { describe, expect, it, vi } from "vitest";

import { NotificationDispatcher, routeNotification } from "@/modules/notifications/notification-router";

const preferences = {
  locale: "zh-CN" as const,
  timeZone: "Asia/Shanghai",
  marketingEnabled: false,
  channelConsent: { email: true, sms: false, inApp: true },
  quietHours: { startHour: 22, endHour: 8 },
};

describe("routeNotification", () => {
  it("suppresses marketing after an opt-out", () => {
    expect(routeNotification({ category: "marketing", preferredChannels: ["email"], preferences,
      now: new Date("2026-08-05T12:00:00Z") })).toEqual({ status: "suppressed", reason: "marketing_opt_out" });
  });

  it("routes required security notices despite marketing opt-out and quiet hours", () => {
    expect(routeNotification({ category: "security", preferredChannels: ["sms", "email"], preferences,
      now: new Date("2026-08-05T15:00:00Z") })).toEqual({
      status: "ready", locale: "zh-CN", channels: ["email", "inApp"],
    });
  });

  it("delays transactional delivery until local quiet hours end", () => {
    expect(routeNotification({ category: "transactional", preferredChannels: ["email"], preferences,
      now: new Date("2026-08-05T15:00:00Z") })).toEqual({
      status: "deferred", locale: "zh-CN", channels: ["email", "inApp"],
      availableAt: new Date("2026-08-06T00:00:00.000Z"),
    });
  });
});

describe("NotificationDispatcher", () => {
  it("falls back by provider without leaking provider failures", async () => {
    const complete = vi.fn();
    const inApp = vi.fn(async () => ({ delivered: true }));
    const dispatcher = new NotificationDispatcher({
      store: { claim: async () => ({ id: "notice-1", leaseId: "lease-1", channels: ["email", "inApp"] as const,
        attempts: 1, maxAttempts: 5, providerIdempotencyKey: "provider-key" }),
        complete, retry: vi.fn(), manualReview: vi.fn() },
      providers: [{ channel: "email", deliver: async () => { throw new Error("provider secret"); } },
        { channel: "inApp", deliver: inApp }],
    });
    await expect(dispatcher.runOne()).resolves.toBe(true);
    expect(inApp).toHaveBeenCalledWith(expect.objectContaining({ id: "notice-1" }),
      { idempotencyKey: "provider-key:inApp" });
    expect(complete).toHaveBeenCalledWith("notice-1", "lease-1");
  });
});
