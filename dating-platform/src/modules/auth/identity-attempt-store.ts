import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { and, desc, eq, lte } from "drizzle-orm";

import { verificationAttempts } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type IdentityDatabase = Pick<typeof productionDatabase, "insert" | "select" | "update">;

export type StoredIdentitySession = {
  redirectUrl: string;
  expiresAt: Date;
};

export class IdentityAttemptConflictError extends Error {
  constructor() {
    super("IDENTITY_ATTEMPT_CONFLICT");
    this.name = "IdentityAttemptConflictError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === "23505") return true;
    current = value.cause;
  }
  return false;
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new Error("IDENTITY_ENCRYPTION_KEY_INVALID");
  return key;
}

function encrypt(key: Buffer, value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(key: Buffer, value: string): string {
  const [version, nonce, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext) throw new Error("IDENTITY_PAYLOAD_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export class DrizzleIdentityAttemptStore {
  private readonly database: IdentityDatabase;
  private readonly key: Buffer;

  constructor(database: unknown, encryptionKey: string, private readonly cooldownMs = 60_000) {
    this.database = database as IdentityDatabase;
    this.key = decodeKey(encryptionKey);
  }

  private hash(idempotencyKey: string): string {
    return createHmac("sha256", this.key).update(idempotencyKey).digest("base64url");
  }

  async findReusable(userId: string, idempotencyKey: string): Promise<StoredIdentitySession | null> {
    const [attempt] = await this.database.select().from(verificationAttempts).where(and(
      eq(verificationAttempts.userId, userId),
      eq(verificationAttempts.kind, "identity"),
      eq(verificationAttempts.idempotencyKeyHash, this.hash(idempotencyKey)),
      eq(verificationAttempts.status, "pending"),
    )).limit(1);
    if (!attempt?.redirectUrlEncrypted || attempt.expiresAt <= new Date()) return null;
    return { redirectUrl: decrypt(this.key, attempt.redirectUrlEncrypted), expiresAt: attempt.expiresAt };
  }

  async availability(userId: string, now = new Date()): Promise<"pending" | "cooldown" | null> {
    await this.database.update(verificationAttempts).set({ status: "expired", updatedAt: now }).where(and(
      eq(verificationAttempts.userId, userId),
      eq(verificationAttempts.kind, "identity"),
      eq(verificationAttempts.status, "pending"),
      lte(verificationAttempts.expiresAt, now),
    ));
    const [pending] = await this.database.select({ id: verificationAttempts.id }).from(verificationAttempts).where(and(
      eq(verificationAttempts.userId, userId),
      eq(verificationAttempts.kind, "identity"),
      eq(verificationAttempts.status, "pending"),
    )).limit(1);
    if (pending) return "pending";
    const [latest] = await this.database.select({ createdAt: verificationAttempts.createdAt }).from(verificationAttempts).where(and(
      eq(verificationAttempts.userId, userId),
      eq(verificationAttempts.kind, "identity"),
    )).orderBy(desc(verificationAttempts.createdAt)).limit(1);
    return latest && latest.createdAt.getTime() + this.cooldownMs > now.getTime() ? "cooldown" : null;
  }

  async create(input: {
    userId: string;
    provider: string;
    providerReference: string;
    idempotencyKey: string;
    redirectUrl: string;
    expiresAt: Date;
  }): Promise<void> {
    try {
      await this.database.insert(verificationAttempts).values({
        userId: input.userId,
        kind: "identity",
        provider: input.provider,
        providerReference: input.providerReference,
        idempotencyKeyHash: this.hash(input.idempotencyKey),
        redirectUrlEncrypted: encrypt(this.key, input.redirectUrl),
        status: "pending",
        expiresAt: input.expiresAt,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new IdentityAttemptConflictError();
      throw error;
    }
  }
}
