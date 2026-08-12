// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { EncryptionKeyRing, StableHmac } from "@/modules/auth/auth-crypto";
import {
  DrizzleIdentityAttemptStore,
  reconcileIdentitySessionIntents,
} from "@/modules/auth/identity-attempt-store";
import type {
  CreateIdentityVerificationInput,
  IdentityVerificationAdapter,
  IdentityVerificationSession,
} from "@/modules/auth/identity-verification-adapter";
import { createIdentityVerificationHandler } from "@/modules/auth/identity-verification-adapter";

const encryption = new EncryptionKeyRing([{
  id: "current",
  key: Buffer.alloc(32, 11).toString("base64"),
}]);
const hmac = new StableHmac("stable-identity-intent-hmac-at-least-32-characters");

class IdempotentAdapter implements IdentityVerificationAdapter {
  readonly createKeys: string[] = [];
  readonly canceled: string[] = [];
  cancelFails = false;
  private readonly sessions = new Map<string, IdentityVerificationSession>();

  async createSession(input: CreateIdentityVerificationInput): Promise<IdentityVerificationSession> {
    this.createKeys.push(input.idempotencyKey);
    const existing = this.sessions.get(input.idempotencyKey);
    if (existing) return existing;
    const session = {
      providerReference: `ref-${input.idempotencyKey.slice(0, 12)}`,
      redirectUrl: `https://identity.example.test/session/${input.idempotencyKey}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    this.sessions.set(input.idempotencyKey, session);
    return session;
  }

  async getResult() { return { status: "pending" as const }; }

  async cancelSession(providerReference: string): Promise<void> {
    if (this.cancelFails) throw new Error("raw vendor cancellation secret");
    this.canceled.push(providerReference);
  }
}

describe("durable identity session intents", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    const [user] = await database.insert(schema.users).values({
      name: "Intent User",
      email: `${crypto.randomUUID()}@example.test`,
    }).returning({ id: schema.users.id });
    userId = user.id;
  }, 30_000);

  afterEach(async () => client.close());

  const store = () => new DrizzleIdentityAttemptStore(database, encryption, hmac);

  it("reconciles a crash after provider creation by retrying the same provider idempotency key", async () => {
    const first = store();
    const intent = await first.beginIntent({ userId, provider: "vendor", idempotencyKey: "crash-key-123" });
    const adapter = new IdempotentAdapter();
    await adapter.createSession({ userId, idempotencyKey: intent.providerIdempotencyKey });
    await database.update(schema.identitySessionIntents).set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.identitySessionIntents.id, intent.id));

    await reconcileIdentitySessionIntents({ store: store(), adapter });

    expect(adapter.createKeys).toEqual([
      intent.providerIdempotencyKey,
      intent.providerIdempotencyKey,
    ]);
    const [attempt] = await database.select().from(schema.verificationAttempts);
    const [persistedIntent] = await database.select().from(schema.identitySessionIntents);
    expect(attempt.providerReference).toBe(`ref-${intent.providerIdempotencyKey.slice(0, 12)}`);
    expect(persistedIntent).toMatchObject({ status: "bound", attemptId: attempt.id });
  });

  it("durably retries compensation when a conflicting session cannot be canceled", async () => {
    await database.insert(schema.verificationAttempts).values({
      userId,
      kind: "identity",
      provider: "vendor",
      providerReference: "existing-ref",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const currentStore = store();
    const intentClaim = await currentStore.beginIntent({
      userId,
      provider: "vendor",
      idempotencyKey: "conflict-key-123",
    });
    await database.update(schema.identitySessionIntents).set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.identitySessionIntents.id, intentClaim.id));
    const adapter = new IdempotentAdapter();
    adapter.cancelFails = true;

    await reconcileIdentitySessionIntents({ store: currentStore, adapter });
    let [intent] = await database.select().from(schema.identitySessionIntents);
    expect(intent.status).toBe("compensation_pending");
    expect(intent.lastError).toBe("IDENTITY_COMPENSATION_FAILED");
    expect(JSON.stringify(intent)).not.toContain("raw vendor cancellation secret");

    adapter.cancelFails = false;
    await database.update(schema.identitySessionIntents).set({ availableAt: new Date(0) })
      .where(eq(schema.identitySessionIntents.id, intent.id));
    await reconcileIdentitySessionIntents({ store: store(), adapter });
    [intent] = await database.select().from(schema.identitySessionIntents);
    expect(intent.status).toBe("compensated");
    expect(adapter.canceled).toHaveLength(1);
  });

  it("recovers and compensates a migrated duplicate intent without a provider reference", async () => {
    await database.insert(schema.identitySessionIntents).values({
      userId,
      provider: "vendor",
      idempotencyHash: "migrated-duplicate-hash",
      providerIdempotencyKey: "migrated-provider-key",
      status: "compensation_pending",
      availableAt: new Date(0),
      lastError: "IDENTITY_INTENT_SUPERSEDED",
    });
    const adapter = new IdempotentAdapter();

    await reconcileIdentitySessionIntents({ store: store(), adapter });

    const [intent] = await database.select().from(schema.identitySessionIntents);
    expect(adapter.createKeys).toEqual(["migrated-provider-key"]);
    expect(adapter.canceled).toEqual(["ref-migrated-pro"]);
    expect(intent).toMatchObject({
      status: "compensated",
      providerReference: "ref-migrated-pro",
      lastError: null,
    });
  });

  it("gates different handler idempotency keys before the provider side effect", async () => {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    const createKeys: string[] = [];
    const adapter: IdentityVerificationAdapter = {
      async createSession(input) {
        createKeys.push(input.idempotencyKey);
        if (createKeys.length === 1) {
          firstEntered();
          await firstBlocked;
        }
        return {
          providerReference: `ref-${input.idempotencyKey.slice(0, 12)}`,
          redirectUrl: `https://identity.example.test/session/${input.idempotencyKey}`,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        };
      },
      async getResult() { return { status: "pending" }; },
      async cancelSession() {},
    };
    const handler = createIdentityVerificationHandler({
      getSession: async () => ({ user: { id: userId } }),
      getContext: async () => ({
        selfDeclaredCountryCode: "US",
        risk: "high",
        satisfied: { email: true, phone: true, liveness: true, identity: false },
      }),
      adapter,
      attemptStore: store(),
      provider: "vendor",
    });
    const request = (idempotencyKey: string) => new Request(
      "https://app.test/api/v1/auth/identity-verification",
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify({ action: "pay" }),
      },
    );

    const first = handler(request("different-key-first"));
    await firstStarted;
    const loser = await handler(request("different-key-second"));
    releaseFirst();
    const winner = await first;

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(409);
    await expect(loser.json()).resolves.toEqual({ error: { code: "IDENTITY_ATTEMPT_PENDING" } });
    expect(createKeys).toHaveLength(1);
    const winnerBody = await winner.json();
    const repeated = await handler(request("different-key-first"));
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual(winnerBody);
    expect(createKeys).toHaveLength(1);
    expect(await database.select().from(schema.identitySessionIntents)).toHaveLength(1);
  });

  it("uses intent lease CAS so an expired old worker cannot regress compensated state", async () => {
    await database.insert(schema.identitySessionIntents).values({
      userId,
      provider: "vendor",
      idempotencyHash: "compensation-hash",
      providerIdempotencyKey: "compensation-provider-key",
      status: "compensation_pending",
      providerReference: "compensation-reference",
      availableAt: new Date(0),
    });
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    let cancelCalls = 0;
    const adapter: IdentityVerificationAdapter = {
      async createSession() { throw new Error("not called"); },
      async getResult() { return { status: "pending" }; },
      async cancelSession() {
        cancelCalls += 1;
        if (cancelCalls === 1) {
          firstEntered();
          await firstBlocked;
          throw new Error("stale worker failure");
        }
      },
    };
    const start = new Date("2026-01-01T00:00:00.000Z");
    const first = reconcileIdentitySessionIntents({ store: store(), adapter, now: start, leaseMs: 1_000 });
    await firstStarted;
    const [claimed] = await database.select().from(schema.identitySessionIntents);
    expect(claimed.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed.leaseExpiresAt).toEqual(new Date(start.getTime() + 1_000));
    await reconcileIdentitySessionIntents({
      store: store(),
      adapter,
      now: new Date(start.getTime() + 1_001),
      leaseMs: 1_000,
    });
    releaseFirst();
    await first;

    const [intent] = await database.select().from(schema.identitySessionIntents);
    expect(intent).toMatchObject({
      status: "compensated",
      leaseId: null,
      leaseExpiresAt: null,
      lastError: null,
    });
    expect(cancelCalls).toBe(2);
  });
});
