import { describe, expect, it, vi } from "vitest";

import {
  HttpMessageSender,
  InMemoryMessageSender,
  NotificationNotConfiguredError,
} from "@/modules/auth/message-sender";

describe("message sender", () => {
  it("fails closed only when an unconfigured provider is used", async () => {
    const sender = new HttpMessageSender({});

    await expect(
      sender.sendSmsOtp({ to: "+12065550100", code: "123456" }, { deliveryKey: "delivery-1" }),
    ).rejects.toEqual(new NotificationNotConfiguredError("sms"));
  });

  it("provides an in-memory sender without logging OTP values", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sender = new InMemoryMessageSender();

    await sender.sendSmsOtp({ to: "+12065550100", code: "739104" }, { deliveryKey: "delivery-2" });

    expect(sender.sms).toEqual([{ to: "+12065550100", code: "739104" }]);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("sends credentials only to a configured HTTPS endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const sender = new HttpMessageSender({
      sms: { endpoint: "https://notify.example.test/sms", token: "provider-token" },
      fetch,
    });

    await sender.sendSmsOtp({ to: "+12065550100", code: "123456" }, { deliveryKey: "stable-delivery-key" });

    expect(fetch).toHaveBeenCalledWith(
      "https://notify.example.test/sms",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer provider-token",
          "idempotency-key": "stable-delivery-key",
        }),
      }),
    );
  });

  it("reuses the provider transport for localized template notifications with a stable key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const sender = new HttpMessageSender({ email: { endpoint: "https://notify.example.test/email",
      token: "provider-token" }, fetch });

    await sender.sendTemplateNotification("email", { to: "owner@example.test",
      templateKey: "privacy.exportReady", locale: "zh-CN" }, { deliveryKey: "stable-template-key" });

    expect(fetch).toHaveBeenCalledWith("https://notify.example.test/email", expect.objectContaining({
      headers: expect.objectContaining({ "idempotency-key": "stable-template-key" }),
      body: JSON.stringify({ channel: "email", to: "owner@example.test",
        templateKey: "privacy.exportReady", locale: "zh-CN" }),
    }));
  });
});
