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
  });

  afterEach(async () => client.close());

  const store = () => new DrizzleIdentityAttemptStore(database, encryption, hmac);

  it("reconciles a crash after provider creation by retrying the same provider idempotency key", async () => {
    const first = store();
    const intent = await first.beginIntent({ userId, provider: "vendor", idempotencyKey: "crash-key-123" });
    const adapter = new IdempotentAdapter();
    await adapter.createSession({ userId, idempotencyKey: intent.providerIdempotencyKey });

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
    await currentStore.beginIntent({ userId, provider: "vendor", idempotencyKey: "conflict-key-123" });
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
});
