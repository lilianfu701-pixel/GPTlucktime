// @vitest-environment node

import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPassword as verifyBetterAuthPassword } from "better-auth/crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FREE_TEST_SEED_ERROR,
  PgSeedDatabase,
  createCredentialsFile,
  executeFreeTestSeed,
  seedFreeTest,
  validateCredentialFileType,
  validateFreeTestSeedEnvironment,
  type FreeTestSeedGraph,
  type FreeTestSeedSnapshot,
  type SeedDatabase,
  type SeedTransaction,
} from "../../../scripts/seed-free-test";

const HOST = "ep-datecn-123.us-east-2.aws.neon.tech";
const DATABASE_URL = `postgresql://datecn_user:fictional-password@${HOST}/datecn_free_test?sslmode=require`;
const validEnv = {
  FREE_TEST_MODE: "1",
  FREE_TEST_SEED_CONFIRM: "datecn-free-test",
  APP_URL: "https://datecn-free-test.vercel.app",
  DATABASE_URL,
};

const tempDirectories: string[] = [];
const tempCredentialsPath = async () => {
  const directory = await mkdtemp(join(tmpdir(), "datecn-seed-test-"));
  tempDirectories.push(directory);
  return join(directory, ".artifacts", "free-test-credentials.json");
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

type State = { graph: FreeTestSeedGraph | null };

class MemoryTransaction implements SeedTransaction {
  constructor(
    private readonly state: State,
    private readonly failAfterInsert: boolean,
  ) {}

  async acquireSeedLock() {}

  async insertMissing(graph: FreeTestSeedGraph) {
    if (!this.state.graph) this.state.graph = structuredClone(graph);
    if (this.failAfterInsert) throw new Error("injected failure after inserts");
  }

  async readSeedSnapshot(): Promise<FreeTestSeedSnapshot> {
    if (!this.state.graph) return { graph: null };
    return { graph: structuredClone(this.state.graph) };
  }
}

class MemoryDatabase implements SeedDatabase {
  state: State = { graph: null };
  transactions = 0;
  failAfterInsert = false;
  private tail: Promise<void> = Promise.resolve();

  async transaction<T>(work: (transaction: SeedTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.transactions += 1;
    const draft = structuredClone(this.state);
    try {
      const result = await work(new MemoryTransaction(draft, this.failAfterInsert));
      this.state = draft;
      return result;
    } finally {
      release();
    }
  }
}

describe("free-test seed environment gate", () => {
  it.each([
    ["missing mode", { FREE_TEST_MODE: undefined }],
    ["wrong mode", { FREE_TEST_MODE: "true" }],
    ["missing confirmation", { FREE_TEST_SEED_CONFIRM: undefined }],
    ["wrong confirmation", { FREE_TEST_SEED_CONFIRM: "datecn" }],
    ["HTTP app URL", { APP_URL: "http://datecn-free-test.vercel.app" }],
    ["localhost app URL", { APP_URL: "https://localhost" }],
    ["localhost subdomain", { APP_URL: "https://app.localhost" }],
    ["IP app URL", { APP_URL: "https://127.0.0.1" }],
    ["URL credentials", { APP_URL: "https://user:secret@datecn-free-test.vercel.app" }],
    ["URL path", { APP_URL: "https://datecn-free-test.vercel.app/member" }],
    ["non-Neon database", { DATABASE_URL: "postgresql://u:p@db.example.com/datecn?sslmode=require" }],
    ["non-TLS Neon database", { DATABASE_URL: `postgresql://u:p@${HOST}/datecn` }],
  ])("rejects %s with one redacted error", (_label, override) => {
    expect(() => validateFreeTestSeedEnvironment({ ...validEnv, ...override }))
      .toThrow(FREE_TEST_SEED_ERROR);
  });

  it.each([
    "E2E_MODE",
    "E2E_CONTROL_TOKEN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "EMAIL_WEBHOOK_URL",
    "SMS_WEBHOOK_TOKEN",
    "IDENTITY_VERIFICATION_API_KEY",
    "REALTIME_PUBLIC_URL",
  ])("rejects external integration variable %s before any write", async (name) => {
    const database = new MemoryDatabase();
    const path = await tempCredentialsPath();
    await expect(seedFreeTest({
      env: { ...validEnv, [name]: "configured-secret-or-url" },
      database,
      credentialsPath: path,
    })).rejects.toThrow(FREE_TEST_SEED_ERROR);
    expect(database.transactions).toBe(0);
    await expect(access(path)).rejects.toBeDefined();
  });

  it("accepts only an exact HTTPS origin and exact Neon database target", () => {
    expect(validateFreeTestSeedEnvironment(validEnv)).toEqual({
      appOrigin: validEnv.APP_URL,
      database: { host: HOST, database: "datecn_free_test" },
    });
  });
});

describe("free-test credentials artifact", () => {
  it("atomically creates two exact synthetic credentials once and reuses them", async () => {
    const path = await tempCredentialsPath();
    const randomBytes = vi.fn(() => Buffer.alloc(24, 7));

    const first = await createCredentialsFile({ path, randomBytes });
    const original = await readFile(path, "utf8");
    const second = await createCredentialsFile({
      path,
      randomBytes: () => { throw new Error("must not regenerate"); },
    });

    expect(first).toEqual(second);
    expect(first.users.map(({ email }) => email)).toEqual([
      "alice@datecn.test",
      "liam@datecn.test",
    ]);
    expect(first.users.every(({ password }) => /^[A-Za-z0-9_-]{32}$/.test(password))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(randomBytes).toHaveBeenCalledTimes(2);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("allows concurrent creators to converge on one complete artifact", async () => {
    const path = await tempCredentialsPath();
    let value = 0;
    const randomBytes = () => Buffer.alloc(24, ++value);

    const [left, right] = await Promise.all([
      createCredentialsFile({ path, randomBytes }),
      createCredentialsFile({ path, randomBytes }),
    ]);

    expect(left).toEqual(right);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(left);
  });

  it("fails closed without replacing malformed or non-synthetic existing credentials", async () => {
    const path = await tempCredentialsPath();
    await createCredentialsFile({ path, randomBytes: () => Buffer.alloc(24, 4) });
    const conflicts = [
      "not json",
      JSON.stringify({ version: 1, users: [
        { email: "alice@example.com", password: "A".repeat(32) },
        { email: "liam@datecn.test", password: "B".repeat(32) },
      ] }),
    ];

    for (const conflict of conflicts) {
      await writeFile(path, conflict, "utf8");
      const before = await readFile(path, "utf8");
      await expect(createCredentialsFile({
        path,
        randomBytes: () => Buffer.alloc(24, 9),
      })).rejects.toThrow(FREE_TEST_SEED_ERROR);
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });

  it("repairs permissions where supported without changing valid credentials", async () => {
    const path = await tempCredentialsPath();
    const credentials = await createCredentialsFile({ path, randomBytes: () => Buffer.alloc(24, 3) });
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      expect(await createCredentialsFile({ path })).toEqual(credentials);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects non-regular or symbolic credential paths", () => {
    expect(() => validateCredentialFileType({ isFile: () => true, isSymbolicLink: () => true }))
      .toThrow(FREE_TEST_SEED_ERROR);
    expect(() => validateCredentialFileType({ isFile: () => false, isSymbolicLink: () => false }))
      .toThrow(FREE_TEST_SEED_ERROR);
    expect(() => validateCredentialFileType({ isFile: () => true, isSymbolicLink: () => false }))
      .not.toThrow();
  });
});

describe("free-test synthetic graph", () => {
  it("executes the production SQL twice against a completely local PostgreSQL schema", async () => {
    const client = new PGlite();
    const local = drizzle(client);
    await migrate(local, { migrationsFolder: "./drizzle" });
    const pool = {
      async connect() {
        return {
          query: (text: string, values?: unknown[]) => client.query(text, values),
          release() {},
        };
      },
      async end() { await client.close(); },
    };
    const database = new PgSeedDatabase(pool as never);
    const credentialsPath = await tempCredentialsPath();
    try {
      await seedFreeTest({ env: validEnv, database, credentialsPath });
      await seedFreeTest({ env: validEnv, database, credentialsPath });
      const counts = await Promise.all([
        "users", "accounts", "profiles", "profile_preferences", "privacy_settings", "profile_photos",
        "social_likes", "social_matches", "entitlement_user_plan_assignments", "conversations",
        "conversation_members", "messages",
      ].map(async (table) => Number((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      )).rows[0]!.count)));
      expect(counts).toEqual([2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 2, 2]);
    } finally {
      await database.close();
    }
  }, 120_000);

  it("creates verified users, complete profiles, reciprocal match, active conversation, free state and messages", async () => {
    const database = new MemoryDatabase();
    const credentialsPath = await tempCredentialsPath();
    const result = await seedFreeTest({
      env: validEnv,
      database,
      credentialsPath,
      randomBytes: () => Buffer.alloc(24, 6),
      hashPassword: async (password) => `test-hash:${password}`,
      verifyPassword: async ({ hash, password }) => hash === `test-hash:${password}`,
    });

    expect(result).toEqual({ users: 2, profiles: 2, matches: 1, conversations: 1, messages: 2 });
    const graph = database.state.graph!;
    expect(graph.users).toHaveLength(2);
    expect(graph.users.every((user) => user.emailVerified && user.email.endsWith("@datecn.test"))).toBe(true);
    expect(graph.profiles).toHaveLength(2);
    expect(graph.profiles.every((profile) => profile.status === "active"
      && profile.discoverable && profile.publishRequested && profile.bio.length > 20
      && profile.birthDate && profile.genderCode && profile.relationshipGoalCode
      && profile.countryCode && profile.timeZone && profile.city)).toBe(true);
    expect(graph.profilePreferences).toHaveLength(2);
    expect(graph.privacySettings).toHaveLength(2);
    expect(graph.interests.map(({ code }) => code)).toEqual(["cooking", "hiking", "photography"]);
    expect(graph.profileInterests).toHaveLength(4);
    expect(graph.photos).toEqual([
      expect.objectContaining({ userId: graph.users[0]!.id, moderationStatus: "approved", position: 0 }),
      expect.objectContaining({ userId: graph.users[1]!.id, moderationStatus: "approved", position: 0 }),
    ]);
    expect(graph.accounts.every((account) => account.accessToken === null
      && account.refreshToken === null && account.idToken === null && account.scope === null)).toBe(true);
    expect(graph.likes).toHaveLength(2);
    expect(graph.match).toMatchObject({ status: "active" });
    expect(graph.conversation).toMatchObject({ status: "active", nextSequence: 3 });
    expect(graph.conversationMembers).toHaveLength(2);
    expect(graph.memberships).toEqual([
      expect.objectContaining({ planRef: "free-test", version: 1, active: true }),
      expect.objectContaining({ planRef: "free-test", version: 1, active: true }),
    ]);
    expect(graph.messages.map(({ sequence, senderUserId }) => ({ sequence, senderUserId }))).toEqual([
      { sequence: 1, senderUserId: graph.users[0]!.id },
      { sequence: 2, senderUserId: graph.users[1]!.id },
    ]);
  });

  it("uses Better Auth compatible password hashes", async () => {
    const database = new MemoryDatabase();
    const credentialsPath = await tempCredentialsPath();
    const credentials = await createCredentialsFile({
      path: credentialsPath,
      randomBytes: () => Buffer.alloc(24, 8),
    });

    await seedFreeTest({ env: validEnv, database, credentialsPath });

    for (const [index, account] of database.state.graph!.accounts.entries()) {
      expect(account.providerId).toBe("credential");
      expect(account.accountId).toBe(account.userId);
      await expect(verifyBetterAuthPassword({
        hash: account.passwordHash,
        password: credentials.users[index]!.password,
      })).resolves.toBe(true);
    }
  });

  it("is idempotent across sequential and concurrent invocations", async () => {
    const database = new MemoryDatabase();
    const credentialsPath = await tempCredentialsPath();
    const options = {
      env: validEnv,
      database,
      credentialsPath,
      randomBytes: () => Buffer.alloc(24, 5),
      hashPassword: async (password: string) => `test-hash:${password}`,
      verifyPassword: async ({ hash, password }: { hash: string; password: string }) =>
        hash === `test-hash:${password}`,
    };

    const first = await seedFreeTest(options);
    const snapshot = structuredClone(database.state.graph);
    const [second, third] = await Promise.all([seedFreeTest(options), seedFreeTest(options)]);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(database.state.graph).toEqual(snapshot);
    expect(database.transactions).toBe(3);
  });

  it("rolls back every inserted row when the transaction fails", async () => {
    const database = new MemoryDatabase();
    database.failAfterInsert = true;

    await expect(seedFreeTest({
      env: validEnv,
      database,
      credentialsPath: await tempCredentialsPath(),
      randomBytes: () => Buffer.alloc(24, 2),
      hashPassword: async (password) => `test-hash:${password}`,
      verifyPassword: async () => true,
    })).rejects.toThrow(FREE_TEST_SEED_ERROR);
    expect(database.state.graph).toBeNull();
  });

  it("fails closed and never overwrites a deterministic conflicting row", async () => {
    const database = new MemoryDatabase();
    const credentialsPath = await tempCredentialsPath();
    const options = {
      env: validEnv,
      database,
      credentialsPath,
      randomBytes: () => Buffer.alloc(24, 1),
      hashPassword: async (password: string) => `test-hash:${password}`,
      verifyPassword: async ({ hash, password }: { hash: string; password: string }) =>
        hash === `test-hash:${password}`,
    };
    await seedFreeTest(options);
    database.state.graph!.users[0]!.email = "real-person@example.com";
    const before = structuredClone(database.state.graph);

    await expect(seedFreeTest(options)).rejects.toThrow(FREE_TEST_SEED_ERROR);
    expect(database.state.graph).toEqual(before);
  });

  it("prints only a fixed error and never credentials or database secrets", async () => {
    const database = new MemoryDatabase();
    database.failAfterInsert = true;
    const stdout = vi.fn();
    const stderr = vi.fn();
    const leakedPassword = Buffer.alloc(24, 12).toString("base64url");

    expect(await executeFreeTestSeed({
      env: validEnv,
      databaseFactory: async () => database,
      credentialsPath: await tempCredentialsPath(),
      randomBytes: () => Buffer.from(leakedPassword, "base64url"),
      hashPassword: async (password) => `test-hash:${password}`,
      verifyPassword: async () => true,
      writeStdout: stdout,
      writeStderr: stderr,
    })).toBe(1);

    const output = JSON.stringify({ stdout: stdout.mock.calls, stderr: stderr.mock.calls });
    expect(stderr).toHaveBeenCalledWith(`${FREE_TEST_SEED_ERROR}\n`);
    expect(output).not.toContain(leakedPassword);
    expect(output).not.toContain("fictional-password");
    expect(output).not.toContain(DATABASE_URL);
  });
});
