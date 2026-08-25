import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/env", () => ({ readEnv: () => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://app:placeholder@localhost:5432/app",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "better-auth-placeholder-secret-at-least-32",
  BETTER_AUTH_URL: "https://dating.example.test/api/auth",
  APP_URL: "https://dating.example.test",
}) }));

import { createFreeTestMailboxHandler } from "@/app/api/free-test/mailbox/route";
import { RedisTokenBucketRateLimiter } from "@/infrastructure/security/rate-limit";
import { FreeTestNotificationAdapter } from "@/modules/auth/free-test-notification-adapter";

class RedisDouble {
  isOpen = false;
  readonly strings = new Map<string, string>();
  readonly rateKeys: string[] = [];
  readonly counts = new Map<string, number>();
  async connect() { this.isOpen = true; }
  async ping() { return "PONG"; }
  async set(key: string, value: string) { this.strings.set(key, value); return "OK"; }
  async getDel(key: string) { const value = this.strings.get(key) ?? null; this.strings.delete(key); return value; }
  async eval(_script: string, options: { keys: string[] }) {
    const key = options.keys[0]!;
    this.rateKeys.push(key);
    const used = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, used);
    return used <= 3 ? [1, 3 - used, 0] : [0, 0, 60_000];
  }
}

const secret = "free-test-access-secret-at-least-32-characters";
const appUrl = "https://dating.example.test";
const email = "route-user@datecn.test";

function request(body: unknown, init: { origin?: string; contentType?: string } = {}) {
  return new Request(`${appUrl}/api/free-test/mailbox`, {
    method: "POST",
    headers: { "content-type": init.contentType ?? "application/json", origin: init.origin ?? appUrl },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function setup(withItem = true) {
  const redis = new RedisDouble();
  const mailbox = new FreeTestNotificationAdapter({ redis, accessSecret: secret, appUrl });
  const limiter = new RedisTokenBucketRateLimiter(redis, { hmacKey: `${secret}:mailbox-rate-limit` });
  const handler = createFreeTestMailboxHandler({ enabled: true, accessSecret: secret, appUrl,
    trustedProxyToken: undefined, mailbox, limiter });
  if (withItem) await mailbox.enqueueEmailVerification({ to: email,
    verificationUrl: `${appUrl}/api/auth/verify-email?token=opaque`,
    validUntil: new Date(Date.now() + 60_000) });
  return { handler, mailbox, redis };
}

async function responseAppearance(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

describe("free-test mailbox route", () => {
  it("is unavailable outside free-test mode", async () => {
    const { mailbox } = await setup();
    const handler = createFreeTestMailboxHandler({ enabled: false, accessSecret: undefined, appUrl,
      trustedProxyToken: undefined, mailbox, limiter: { consume: vi.fn() } });
    const response = await handler(request({ email, accessCode: secret }));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires exact origin, strict schema, test-domain email, and a body no larger than 4 KiB", async () => {
    const cases: Array<[Request, number]> = [
      [request({ email, accessCode: secret }, { origin: "https://evil.example.test" }), 403],
      [request({ email: "person@example.test", accessCode: secret }), 400],
      [request({ email: "bad@@datecn.test", accessCode: secret }), 400],
      [request({ email, accessCode: secret, extra: true }), 400],
      [request({ email, accessCode: secret, padding: "x".repeat(4_096) }), 413],
    ];
    for (const [input, status] of cases) {
      const { handler } = await setup();
      const response = await handler(input);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("token=opaque");
    }
  });

  it("does not reveal access-code validity and compares it before one-time consumption", async () => {
    const { handler } = await setup();
    const wrongAppearance = await responseAppearance(
      await handler(request({ email: email.toUpperCase(), accessCode: `${secret}-wrong` })),
    );
    expect(wrongAppearance.status).toBe(404);
    expect(wrongAppearance.body).not.toContain("token=opaque");

    const success = await handler(request({ email: email.toUpperCase(), accessCode: secret }));
    expect(success.status).toBe(200);
    expect(success.headers.get("cache-control")).toBe("no-store");
    expect(await success.json()).toEqual({ kind: "email_verification",
      actionUrl: `${appUrl}/api/auth/verify-email?token=opaque`, expiresAt: expect.any(String) });

    const consumedAppearance = await responseAppearance(await handler(request({ email, accessCode: secret })));
    const { handler: emptyHandler } = await setup(false);
    const emptyAppearance = await responseAppearance(await emptyHandler(request({ email, accessCode: secret })));
    expect(consumedAppearance).toEqual(wrongAppearance);
    expect(emptyAppearance).toEqual(wrongAppearance);
  });

  it("rate limits by an opaque HMAC key without exposing email or client bucket", async () => {
    const { handler, redis } = await setup();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await handler(request({ email, accessCode: "wrong-access-code" }))).status).toBe(404);
    }
    const limited = await handler(request({ email, accessCode: secret }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(redis.rateKeys).toHaveLength(4);
    expect(redis.rateKeys.every((key) => !key.includes(email) && !key.includes("untrusted-network"))).toBe(true);
  });
});
