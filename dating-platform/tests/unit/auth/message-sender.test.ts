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
      sender.sendSmsOtp({ to: "+12065550100", code: "123456" }),
    ).rejects.toEqual(new NotificationNotConfiguredError("sms"));
  });

  it("provides an in-memory sender without logging OTP values", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sender = new InMemoryMessageSender();

    await sender.sendSmsOtp({ to: "+12065550100", code: "739104" });

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

    await sender.sendSmsOtp({ to: "+12065550100", code: "123456" });

    expect(fetch).toHaveBeenCalledWith(
      "https://notify.example.test/sms",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer provider-token" }),
      }),
    );
  });
});
