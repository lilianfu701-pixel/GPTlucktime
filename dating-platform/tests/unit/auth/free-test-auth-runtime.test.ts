import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const captured = vi.hoisted(() => ({ configuration: null as Record<string, unknown> | null }));
const redis = vi.hoisted(() => ({
  isOpen: false,
  connect: vi.fn(async () => undefined),
  ping: vi.fn(async () => "PONG"),
  set: vi.fn(async () => "OK"),
  getDel: vi.fn(async () => null),
  on: vi.fn(),
}));
const createRedisClient = vi.hoisted(() => vi.fn(() => redis));
vi.mock("redis", () => ({ createClient: createRedisClient }));
vi.mock("better-auth/minimal", () => ({ betterAuth: vi.fn((value) => value) }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: vi.fn(() => ({ id: "database" })) }));
vi.mock("@/db/schema", () => ({}));
vi.mock("@/infrastructure/db/client", () => ({ db: {} }));
vi.mock("@/modules/auth/auth-config", () => ({ createAuthConfiguration: vi.fn((input) => {
  captured.configuration = input;
  return input;
}) }));
vi.mock("@/modules/e2e/e2e-guard", () => ({ requireE2eRuntime: vi.fn(() => ({ secret: "e2e" })) }));

describe("free-test auth runtime", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); captured.configuration = null; });

  it("uses one synthetic adapter as sender and dispatcher and leaves the durable worker idle", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://app:placeholder@localhost:5432/app");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("BETTER_AUTH_SECRET", "better-auth-placeholder-secret-at-least-32");
    vi.stubEnv("BETTER_AUTH_URL", "https://dating.example.test/api/auth");
    vi.stubEnv("APP_URL", "https://dating.example.test");
    vi.stubEnv("FREE_TEST_MODE", "1");
    vi.stubEnv("FREE_TEST_ACCESS_SECRET", "free-test-placeholder-secret-at-least-32");
    vi.stubEnv("E2E_MODE", "");

    const runtime = await import("@/modules/auth/auth");
    expect(captured.configuration?.sender).toBe(captured.configuration?.dispatcher);
    expect(captured.configuration?.sender?.constructor.name).toBe("FreeTestNotificationAdapter");
    expect(createRedisClient).toHaveBeenCalledWith(expect.objectContaining({ socket: expect.objectContaining({
      connectTimeout: expect.any(Number), socketTimeout: expect.any(Number),
      reconnectStrategy: expect.any(Function),
    }) }));
    expect(redis.on).toHaveBeenCalledWith("error", expect.any(Function));
    await expect(runtime.runAuthNotificationDeliveryWorker()).resolves.toBe(0);
  });

  it("keeps the isolated E2E adapter ahead of the free-test adapter", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://app:placeholder@localhost:5432/app");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("BETTER_AUTH_SECRET", "better-auth-placeholder-secret-at-least-32");
    vi.stubEnv("BETTER_AUTH_URL", "https://dating.example.test/api/auth");
    vi.stubEnv("APP_URL", "https://dating.example.test");
    vi.stubEnv("FREE_TEST_MODE", "1");
    vi.stubEnv("FREE_TEST_ACCESS_SECRET", "free-test-placeholder-secret-at-least-32");
    vi.stubEnv("E2E_MODE", "1");

    await import("@/modules/auth/auth");
    expect(captured.configuration?.sender).toBe(captured.configuration?.dispatcher);
    expect(captured.configuration?.sender?.constructor.name).toBe("E2eNotificationAdapter");
  });
});
