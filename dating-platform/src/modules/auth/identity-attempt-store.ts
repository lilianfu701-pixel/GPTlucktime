import { and, desc, eq, inArray, lte } from "drizzle-orm";

import { identitySessionIntents, verificationAttempts } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import { EncryptionKeyRing, StableHmac } from "./auth-crypto";
import type {
  IdentityVerificationAdapter,
  IdentityVerificationSession,
} from "./identity-verification-adapter";

type IdentityDatabase = typeof productionDatabase;
type IdentityIntent = typeof identitySessionIntents.$inferSelect;

export type StoredIdentitySession = { redirectUrl: string; expiresAt: Date };

export class IdentityAttemptConflictError extends Error {
  constructor(readonly intentId?: string) {
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

export class DrizzleIdentityAttemptStore {
  private readonly database: IdentityDatabase;

  constructor(
    database: unknown,
    private readonly encryption: EncryptionKeyRing,
    private readonly identityHmac: StableHmac,
    private readonly cooldownMs = 60_000,
  ) {
    this.database = database as IdentityDatabase;
  }

  private hash(userId: string, idempotencyKey: string): string {
    return this.identityHmac.digest("request", userId, idempotencyKey);
  }

  async findReusable(userId: string, idempotencyKey: string): Promise<StoredIdentitySession | null> {
    const [attempt] = await this.database.select().from(verificationAttempts).where(and(
      eq(verificationAttempts.userId, userId),
      eq(verificationAttempts.kind, "identity"),
      eq(verificationAttempts.idempotencyKeyHash, this.hash(userId, idempotencyKey)),
      eq(verificationAttempts.status, "pending"),
    )).limit(1);
    if (
      !attempt?.redirectEncryptionKeyId ||
      !attempt.redirectUrlEncrypted ||
      attempt.expiresAt <= new Date()
    ) return null;
    return {
      redirectUrl: this.encryption.decrypt({
        keyId: attempt.redirectEncryptionKeyId,
        ciphertext: attempt.redirectUrlEncrypted,
      }),
      expiresAt: attempt.expiresAt,
    };
  }

  async availability(userId: string, now = new Date()): Promise<"pending" | "cooldown" | null> {
    await this.database.update(verificationAttempts).set({
      status: "expired",
      redirectUrlEncrypted: null,
      redirectEncryptionKeyId: null,
      updatedAt: now,
    }).where(and(
      eq(verificationAttempts.userId, userId),
      eq(verificationAttempts.kind, "identity"),
      eq(verificationAttempts.status, "pending"),
      lte(verificationAttempts.expiresAt, now),
    ));
    const [pending] = await this.database.select({ id: verificationAttempts.id })
      .from(verificationAttempts).where(and(
        eq(verificationAttempts.userId, userId),
        eq(verificationAttempts.kind, "identity"),
        eq(verificationAttempts.status, "pending"),
      )).limit(1);
    if (pending) return "pending";
    const [latest] = await this.database.select({ createdAt: verificationAttempts.createdAt })
      .from(verificationAttempts).where(and(
        eq(verificationAttempts.userId, userId),
        eq(verificationAttempts.kind, "identity"),
      )).orderBy(desc(verificationAttempts.createdAt)).limit(1);
    return latest && latest.createdAt.getTime() + this.cooldownMs > now.getTime()
      ? "cooldown"
      : null;
  }

  async beginIntent(input: {
    userId: string;
    provider: string;
    idempotencyKey: string;
  }): Promise<IdentityIntent> {
    const idempotencyHash = this.hash(input.userId, input.idempotencyKey);
    const providerIdempotencyKey = this.identityHmac.digest(
      "provider",
      input.userId,
      input.idempotencyKey,
    );
    const [inserted] = await this.database.insert(identitySessionIntents).values({
      userId: input.userId,
      provider: input.provider,
      idempotencyHash,
      providerIdempotencyKey,
    }).onConflictDoNothing({
      target: [
        identitySessionIntents.userId,
        identitySessionIntents.kind,
        identitySessionIntents.idempotencyHash,
      ],
    }).returning();
    if (inserted) return inserted;
    const [existing] = await this.database.select().from(identitySessionIntents).where(and(
      eq(identitySessionIntents.userId, input.userId),
      eq(identitySessionIntents.kind, "identity"),
      eq(identitySessionIntents.idempotencyHash, idempotencyHash),
    )).limit(1);
    if (!existing) throw new Error("IDENTITY_INTENT_NOT_FOUND");
    return existing;
  }

  async bindIntent(intentId: string, hosted: IdentityVerificationSession): Promise<void> {
    try {
      await this.database.transaction(async (transaction) => {
        const [intent] = await transaction.select().from(identitySessionIntents)
          .where(eq(identitySessionIntents.id, intentId)).limit(1);
        if (!intent) throw new Error("IDENTITY_INTENT_NOT_FOUND");
        if (intent.status === "bound") return;
        const redirect = this.encryption.encrypt(hosted.redirectUrl);
        const [attempt] = await transaction.insert(verificationAttempts).values({
          userId: intent.userId,
          kind: "identity",
          provider: intent.provider,
          providerReference: hosted.providerReference,
          idempotencyKeyHash: intent.idempotencyHash,
          redirectUrlEncrypted: redirect.ciphertext,
          redirectEncryptionKeyId: redirect.keyId,
          status: "pending",
          expiresAt: hosted.expiresAt,
        }).returning({ id: verificationAttempts.id });
        await transaction.update(identitySessionIntents).set({
          status: "bound",
          providerReference: hosted.providerReference,
          attemptId: attempt.id,
          lastError: null,
          updatedAt: new Date(),
        }).where(eq(identitySessionIntents.id, intentId));
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [intent] = await this.database.select().from(identitySessionIntents)
        .where(eq(identitySessionIntents.id, intentId)).limit(1);
      if (intent?.status === "bound") return;
      await this.markCompensationPending(intentId, hosted.providerReference);
      throw new IdentityAttemptConflictError(intentId);
    }
  }

  async create(input: {
    userId: string;
    provider: string;
    providerReference: string;
    idempotencyKey: string;
    redirectUrl: string;
    expiresAt: Date;
  }): Promise<void> {
    const intent = await this.beginIntent(input);
    await this.bindIntent(intent.id, input);
  }

  async listRecoverable(now = new Date(), limit = 50): Promise<IdentityIntent[]> {
    return this.database.select().from(identitySessionIntents).where(and(
      inArray(identitySessionIntents.status, ["initiating", "compensation_pending"]),
      lte(identitySessionIntents.availableAt, now),
    )).limit(limit);
  }

  async markCompensationPending(intentId: string, providerReference: string): Promise<void> {
    await this.database.update(identitySessionIntents).set({
      status: "compensation_pending",
      providerReference,
      lastError: "IDENTITY_ATTEMPT_CONFLICT",
      updatedAt: new Date(),
    }).where(eq(identitySessionIntents.id, intentId));
  }

  async markCompensated(intentId: string): Promise<void> {
    await this.database.update(identitySessionIntents).set({
      status: "compensated",
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(identitySessionIntents.id, intentId));
  }

  async recordRetry(
    intentId: string,
    status: "initiating" | "compensation_pending",
    attempts: number,
    errorCode: "IDENTITY_PROVIDER_FAILED" | "IDENTITY_COMPENSATION_FAILED",
    now = new Date(),
  ): Promise<void> {
    await this.database.update(identitySessionIntents).set({
      status,
      attempts,
      availableAt: new Date(now.getTime() + Math.min(5 * 60_000, 1_000 * (2 ** attempts))),
      lastError: errorCode,
      updatedAt: now,
    }).where(eq(identitySessionIntents.id, intentId));
  }
}

export async function reconcileIdentitySessionIntents(input: {
  store: DrizzleIdentityAttemptStore;
  adapter: IdentityVerificationAdapter;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const intents = await input.store.listRecoverable(now);
  for (const intent of intents) {
    if (intent.status === "compensation_pending") {
      if (!intent.providerReference) {
        await input.store.recordRetry(
          intent.id,
          "compensation_pending",
          intent.attempts + 1,
          "IDENTITY_COMPENSATION_FAILED",
          now,
        );
        continue;
      }
      try {
        await input.adapter.cancelSession(intent.providerReference);
        await input.store.markCompensated(intent.id);
      } catch {
        await input.store.recordRetry(
          intent.id,
          "compensation_pending",
          intent.attempts + 1,
          "IDENTITY_COMPENSATION_FAILED",
          now,
        );
      }
      continue;
    }

    let hosted: IdentityVerificationSession;
    try {
      hosted = await input.adapter.createSession({
        userId: intent.userId,
        idempotencyKey: intent.providerIdempotencyKey,
      });
    } catch {
      await input.store.recordRetry(
        intent.id,
        "initiating",
        intent.attempts + 1,
        "IDENTITY_PROVIDER_FAILED",
        now,
      );
      continue;
    }
    try {
      await input.store.bindIntent(intent.id, hosted);
    } catch (error) {
      if (!(error instanceof IdentityAttemptConflictError)) throw error;
      try {
        await input.adapter.cancelSession(hosted.providerReference);
        await input.store.markCompensated(intent.id);
      } catch {
        await input.store.recordRetry(
          intent.id,
          "compensation_pending",
          intent.attempts + 1,
          "IDENTITY_COMPENSATION_FAILED",
          now,
        );
      }
    }
  }
  return intents.length;
}
