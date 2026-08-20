import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("notification production wiring", () => {
  it("connects the durable store and existing provider transport to an authenticated worker tick", () => {
    expect(existsSync("src/modules/notifications/notification-runtime.ts")).toBe(true);
    expect(existsSync("src/app/api/internal/workers/notifications/route.ts")).toBe(true);
    const runtime = readFileSync("src/modules/notifications/notification-runtime.ts", "utf8");
    const route = readFileSync("src/app/api/internal/workers/notifications/route.ts", "utf8");
    expect(runtime).toContain('import "server-only"');
    expect(runtime).toContain("DrizzleNotificationStore");
    expect(runtime).toContain("HttpMessageSender");
    expect(runtime).toContain("EMAIL_FALLBACK_WEBHOOK_URL");
    expect(runtime).toContain("SMS_FALLBACK_WEBHOOK_URL");
    expect(runtime).toContain("DrizzleInAppNotificationProvider");
    expect(runtime).toContain("runAuthNotificationDeliveryWorker");
    expect(route).toContain("NOTIFICATION_WORKER_CRON_SECRET");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain("messageKey");
    expect(route).toContain("retryable");
    expect(route).toContain("traceId");
    expect(route).toContain("export const GET = handler");
  });

  it("wires every preferences verb, the shared limiter, and quiet-hours controls", () => {
    const route = readFileSync("src/app/api/v1/me/notification-preferences/route.ts", "utf8");
    const form = readFileSync("src/app/[locale]/(member)/settings/notifications/preferences-form.tsx", "utf8");
    for (const verb of ["GET", "POST", "PATCH", "PUT", "DELETE"]) expect(route).toContain(`export const ${verb} = handler`);
    expect(route).toContain("RedisPrivacyRateLimiter");
    expect(form).toContain("quietStartHour");
    expect(form).toContain("quietEndHour");
    expect(form).toContain('type="number"');
  });
});
