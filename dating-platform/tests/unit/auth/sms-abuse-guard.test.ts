import { describe, expect, it } from "vitest";

import {
  InMemorySmsAbuseStore,
  SmsAbuseError,
  SmsAbuseGuard,
  validateSmsTarget,
} from "@/modules/auth/sms-abuse-guard";

const config = {
  hmacKey: "sms-abuse-secret-at-least-32-characters",
  allowedCallingCodes: ["1", "44"],
  highRiskCallingCodes: ["44"],
  deniedPrefixes: ["+1900"],
  cooldownMs: 60_000,
  windowMs: 3_600_000,
  ipLimit: 2,
  actorLimit: 2,
  targetLimit: 2,
};

describe("SMS abuse guard", () => {
  it.each(["4155550123", "+0123456789", "+1 4155550123", "+123", "+".concat("1".repeat(16))])(
    "rejects non-E.164 target %s",
    (target) => expect(() => validateSmsTarget(target, config)).toThrow(SmsAbuseError),
  );

  it("rejects unsupported and denied destinations", () => {
    expect(() => validateSmsTarget("+33123456789", config)).toThrow("SMS_COUNTRY_NOT_ALLOWED");
    expect(() => validateSmsTarget("+19005550123", config)).toThrow("SMS_DESTINATION_DENIED");
  });

  it("shares target cooldown state across guard instances without storing the phone number", async () => {
    const store = new InMemorySmsAbuseStore();
    const first = new SmsAbuseGuard(store, config);
    const restarted = new SmsAbuseGuard(store, config);
    await first.check({ ip: "203.0.113.1", actorId: "user-1", target: "+14155550123" });
    await expect(restarted.check({ ip: "203.0.113.2", actorId: "user-2", target: "+14155550123" }))
      .rejects.toThrow("SMS_COOLDOWN");
    expect(store.keys().join(" ")).not.toContain("+14155550123");
  });

  it("enforces persistent IP windows", async () => {
    const store = new InMemorySmsAbuseStore();
    const guard = new SmsAbuseGuard(store, { ...config, cooldownMs: 0 });
    await guard.check({ ip: "203.0.113.9", target: "+14155550123" });
    await guard.check({ ip: "203.0.113.9", target: "+14155550124" });
    await expect(guard.check({ ip: "203.0.113.9", target: "+14155550125" }))
      .rejects.toThrow("SMS_RATE_LIMITED");
  });

  it("fails closed for high-risk destinations unless a challenge is verified", async () => {
    const store = new InMemorySmsAbuseStore();
    const guard = new SmsAbuseGuard(store, config);
    await expect(guard.check({ ip: "203.0.113.10", target: "+447700900123" }))
      .rejects.toThrow("SMS_CHALLENGE_REQUIRED");
    await expect(guard.check({
      ip: "203.0.113.10",
      target: "+447700900123",
      challengeVerified: true,
    })).resolves.toBeUndefined();
  });
});
