// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { EncryptionKeyRing, StableHmac } from "@/modules/auth/auth-crypto";
import {
  DrizzleIdentityAttemptStore,
  IdentityAttemptConflictError,
} from "@/modules/auth/identity-attempt-store";

const key = (id: string, byte: number) => ({ id, key: Buffer.alloc(32, byte).toString("base64") });
const hmac = new StableHmac("stable-identity-hmac-key-at-least-32-characters");

describe("identity attempt store", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    const [user] = await database.insert(schema.users).values({
      name: "Identity User",
      email: `${crypto.randomUUID()}@example.test`,
    }).returning({ id: schema.users.id });
    userId = user.id;
  });

  afterEach(async () => client.close());

  const attempt = (idempotencyKey: string, suffix: string) => ({
    userId,
    provider: "vendor",
    providerReference: `ref-${suffix}`,
    idempotencyKey,
    redirectUrl: `https://identity.example.test/session/${suffix}?secret=hidden`,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });

  it("returns the same encrypted redirect for a repeated idempotency key", async () => {
    const oldStore = new DrizzleIdentityAttemptStore(
      database,
      new EncryptionKeyRing([key("old", 9)]),
      hmac,
    );
    const input = attempt("repeat-key-123", "one");
    await oldStore.create(input);
    const rotated = new DrizzleIdentityAttemptStore(
      database,
      new EncryptionKeyRing([key("current", 10), key("old", 9)]),
      hmac,
    );
    await expect(rotated.findReusable(userId, input.idempotencyKey)).resolves.toEqual({
      redirectUrl: input.redirectUrl,
      expiresAt: input.expiresAt,
    });
    const [row] = await database.select().from(schema.verificationAttempts);
    expect(JSON.stringify(row)).not.toContain(input.idempotencyKey);
    expect(JSON.stringify(row)).not.toContain("secret=hidden");
    expect(row.redirectEncryptionKeyId).toBe("old");
  });

  it("allows at most one concurrent pending identity attempt per user", async () => {
    const first = new DrizzleIdentityAttemptStore(database, new EncryptionKeyRing([key("current", 9)]), hmac);
    const second = new DrizzleIdentityAttemptStore(database, new EncryptionKeyRing([key("current", 9)]), hmac);
    const results = await Promise.allSettled([
      first.create(attempt("concurrent-key-a", "a")),
      second.create(attempt("concurrent-key-b", "b")),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(({ status }) => status === "rejected");
    expect(rejection && rejection.status === "rejected" ? rejection.reason : null)
      .toBeInstanceOf(IdentityAttemptConflictError);
    expect(await database.select().from(schema.verificationAttempts)).toHaveLength(1);
  });

  it("does not apply the identity-only pending constraint to other verification kinds", async () => {
    await expect(database.insert(schema.verificationAttempts).values([
      { userId, kind: "liveness", status: "pending", expiresAt: new Date(Date.now() + 60_000) },
      { userId, kind: "liveness", status: "pending", expiresAt: new Date(Date.now() + 60_000) },
    ])).resolves.toBeDefined();
  });
});
