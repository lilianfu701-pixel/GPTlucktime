import { describe, expect, it, vi } from "vitest";

import { createNotificationPreferencesHandler } from "@/modules/notifications/notification-preferences";

describe("notification preferences route", () => {
  const current = { locale: "zh-CN" as const, timeZone: "Asia/Shanghai", marketingEnabled: false,
    emailEnabled: true, smsEnabled: false, inAppEnabled: true, quietStartHour: 22, quietEndHour: 8 };

  it("authenticates before method or payload handling", async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const handler = createNotificationPreferencesHandler({ getSession,
      repository: { get: vi.fn(), update: vi.fn() }, limiter: { consume: vi.fn() } });
    const response = await handler(new Request("https://app.test/api/v1/me/notification-preferences", {
      method: "DELETE", body: "not-json" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED", messageKey: "errors.unauthorized" } });
  });

  it("returns and strictly updates the server-authoritative locale, timezone and consents", async () => {
    const repository = { get: vi.fn().mockResolvedValue(current), update: vi.fn().mockResolvedValue(current) };
    const handler = createNotificationPreferencesHandler({ getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      repository, limiter: { consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) } });
    expect(await (await handler(new Request("https://app.test/api/v1/me/notification-preferences"))).json())
      .toEqual({ data: { preferences: current } });
    const response = await handler(new Request("https://app.test/api/v1/me/notification-preferences", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify(current) }));
    expect(response.status).toBe(200);
    expect(repository.update).toHaveBeenCalledWith("user-1", current);
  });

  it("bounds GET URLs and fails closed when the shared limiter is unavailable", async () => {
    const repository = { get: vi.fn(), update: vi.fn() };
    const getSession = vi.fn().mockResolvedValue({ user: { id: "user-1" } });
    const bounded = createNotificationPreferencesHandler({ getSession, repository,
      limiter: { consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) } });
    expect((await bounded(new Request(`https://app.test/api/v1/me/notification-preferences?x=${"a".repeat(2050)}`))).status)
      .toBe(414);
    const unavailable = createNotificationPreferencesHandler({ getSession, repository,
      limiter: { consume: vi.fn().mockRejectedValue(new Error("redis unavailable")) } });
    expect((await unavailable(new Request("https://app.test/api/v1/me/notification-preferences"))).status).toBe(503);
    expect(repository.get).not.toHaveBeenCalled();
  });
});
