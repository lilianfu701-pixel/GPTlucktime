import { afterEach, describe, expect, it, vi } from "vitest";

describe("verification webhook route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rejects a bad signature before touching verification state", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://app:secret@localhost:5432/dating_platform");
    vi.stubEnv("REDIS_URL", "redis://:secret@localhost:6379");
    vi.stubEnv("BETTER_AUTH_SECRET", "a-secure-test-secret-with-32-characters");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000/api/auth");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("IDENTITY_VERIFICATION_PROVIDER", "vendor");
    vi.stubEnv("IDENTITY_VERIFICATION_URL", "https://identity.example.test");
    vi.stubEnv("IDENTITY_VERIFICATION_API_KEY", "identity-api-key-at-least-32-characters");
    vi.stubEnv("IDENTITY_VERIFICATION_WEBHOOK_SECRET", "webhook-test-secret-at-least-32-chars");
    vi.stubEnv("IDENTITY_REDIRECT_ORIGINS", "https://identity.example.test");
    vi.stubEnv("AUTH_ENCRYPTION_KEYS", `current:${Buffer.alloc(32, 6).toString("base64")}`);
    vi.stubEnv("IDENTITY_IDEMPOTENCY_HMAC_KEY", "identity-idempotency-hmac-at-least-32-chars");
    const { POST } = await import(
      "@/app/api/v1/webhooks/verification/[provider]/route"
    );

    const response = await POST(new Request("https://app.test/webhook", {
      method: "POST",
      headers: { "x-verification-signature": "sha256=00" },
      body: JSON.stringify({
        eventId: "event-1",
        providerReference: "reference-1",
        status: "approved",
      }),
    }), { params: Promise.resolve({ provider: "vendor" }) });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "INVALID_SIGNATURE" } });
  });
});
