import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const authWorker = vi.hoisted(() => vi.fn(async () => 9));
const runOne = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/modules/auth/auth", () => ({ runAuthNotificationDeliveryWorker: authWorker }));
vi.mock("@/shared/env", () => ({ readEnv: () => ({ FREE_TEST_MODE: "1", BETTER_AUTH_SECRET: "x".repeat(32) }) }));
vi.mock("@/infrastructure/db/client", () => ({ db: {} }));
vi.mock("@/modules/notifications/notification-router", () => ({
  NotificationDispatcher: class { runOne = runOne; },
}));
vi.mock("@/modules/notifications/notification-store", () => ({
  DrizzleInAppNotificationProvider: class {},
  DrizzleNotificationStore: class {},
}));

import { runConfiguredNotificationWorkers } from "@/modules/notifications/notification-runtime";

describe("free-test notification worker", () => {
  it("is a complete no-op", async () => {
    await expect(runConfiguredNotificationWorkers()).resolves.toEqual({ authProcessed: 0, notificationsProcessed: 0 });
    expect(authWorker).not.toHaveBeenCalled();
    expect(runOne).not.toHaveBeenCalled();
  });
});
