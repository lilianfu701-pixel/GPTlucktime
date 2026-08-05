import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";

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

export class IdentityIntentLeaseLostError extends Error {
  constructor() {
    super("IDENTITY_INTENT_LEASE_LOST");
    this.name = "IdentityIntentLeaseLostError";
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
    private readonly requestLeaseMs = 30_000,
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
      !attempt?.redirectUrlEncrypted ||
      attempt.expiresAt <= new Date()
    ) return null;
    return {
      redirectUrl: this.encryption.decrypt({
        keyId: attempt.redirectEncryptionKeyId,
        ciphertext: attempt.redirectUrlEncrypted,
        legacyPurpose: "identity",
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
  }, now = new Date()): Promise<IdentityIntent & { acquired: boolean }> {
    const idempotencyHash = this.hash(input.userId, input.idempotencyKey);
    const providerIdempotencyKey = this.identityHmac.digest(
      "provider",
      input.userId,
      input.idempotencyKey,
    );
    const leaseId = randomUUID();
    try {
      const [inserted] = await this.database.insert(identitySessionIntents).values({
        userId: input.userId,
        provider: input.provider,
        idempotencyHash,
        providerIdempotencyKey,
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + this.requestLeaseMs),
      }).returning();
      return { ...inserted, acquired: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const [existing] = await this.database.select().from(identitySessionIntents).where(and(
      eq(identitySessionIntents.userId, input.userId),
      eq(identitySessionIntents.kind, "identity"),
      eq(identitySessionIntents.idempotencyHash, idempotencyHash),
    )).limit(1);
    if (!existing) throw new IdentityAttemptConflictError();
    return { ...existing, acquired: false };
  }

  async bindIntent(
    intentId: string,
    hosted: IdentityVerificationSession,
    leaseId: string,
  ): Promise<void> {
    try {
      await this.database.transaction(async (transaction) => {
        const [intent] = await transaction.select().from(identitySessionIntents)
          .where(and(
            eq(identitySessionIntents.id, intentId),
            eq(identitySessionIntents.status, "initiating"),
            eq(identitySessionIntents.leaseId, leaseId),
          )).limit(1);
        if (!intent) throw new IdentityIntentLeaseLostError();
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
        const updated = await transaction.update(identitySessionIntents).set({
          status: "bound",
          providerReference: hosted.providerReference,
          attemptId: attempt.id,
          lastError: null,
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(identitySessionIntents.id, intentId),
          eq(identitySessionIntents.status, "initiating"),
          eq(identitySessionIntents.leaseId, leaseId),
        )).returning({ id: identitySessionIntents.id });
        if (updated.length !== 1) throw new IdentityIntentLeaseLostError();
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const marked = await this.markCompensationPending(
        intentId,
        leaseId,
        hosted.providerReference,
      );
      if (!marked) throw new IdentityIntentLeaseLostError();
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
    if (!intent.acquired || !intent.leaseId) throw new IdentityAttemptConflictError(intent.id);
    await this.bindIntent(intent.id, input, intent.leaseId);
  }

  async claimRecoverable(
    now = new Date(),
    leaseMs = 30_000,
    limit = 50,
  ): Promise<IdentityIntent[]> {
    const candidates = await this.database.select().from(identitySessionIntents).where(and(
      inArray(identitySessionIntents.status, ["initiating", "compensation_pending"]),
      lte(identitySessionIntents.availableAt, now),
      or(
        isNull(identitySessionIntents.leaseId),
        lte(identitySessionIntents.leaseExpiresAt, now),
      ),
    )).limit(limit);
    const claimed: IdentityIntent[] = [];
    for (const candidate of candidates) {
      const leaseId = randomUUID();
      const [intent] = await this.database.update(identitySessionIntents).set({
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      }).where(and(
        eq(identitySessionIntents.id, candidate.id),
        eq(identitySessionIntents.status, candidate.status),
        lte(identitySessionIntents.availableAt, now),
        or(
          isNull(identitySessionIntents.leaseId),
          lte(identitySessionIntents.leaseExpiresAt, now),
        ),
      )).returning();
      if (intent) claimed.push(intent);
    }
    return claimed;
  }

  async renewLease(
    intentId: string,
    leaseId: string,
    status: "initiating" | "compensation_pending",
    leaseMs: number,
    now = new Date(),
  ): Promise<boolean> {
    const updated = await this.database.update(identitySessionIntents).set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    }).where(and(
      eq(identitySessionIntents.id, intentId),
      eq(identitySessionIntents.leaseId, leaseId),
      eq(identitySessionIntents.status, status),
    )).returning({ id: identitySessionIntents.id });
    return updated.length === 1;
  }

  async rejectIntent(
    intentId: string,
    leaseId: string,
    errorCode: "IDENTITY_ATTEMPT_PENDING" | "IDENTITY_ATTEMPT_COOLDOWN",
    now = new Date(),
  ): Promise<boolean> {
    const updated = await this.database.update(identitySessionIntents).set({
      status: "failed",
      leaseId: null,
      leaseExpiresAt: null,
      lastError: errorCode,
      updatedAt: now,
    }).where(and(
      eq(identitySessionIntents.id, intentId),
      eq(identitySessionIntents.status, "initiating"),
      eq(identitySessionIntents.leaseId, leaseId),
    )).returning({ id: identitySessionIntents.id });
    return updated.length === 1;
  }

  async markCompensationPending(
    intentId: string,
    leaseId: string,
    providerReference: string,
  ): Promise<boolean> {
    const updated = await this.database.update(identitySessionIntents).set({
      status: "compensation_pending",
      providerReference,
      lastError: "IDENTITY_ATTEMPT_CONFLICT",
      updatedAt: new Date(),
    }).where(and(
      eq(identitySessionIntents.id, intentId),
      eq(identitySessionIntents.status, "initiating"),
      eq(identitySessionIntents.leaseId, leaseId),
    )).returning({ id: identitySessionIntents.id });
    return updated.length === 1;
  }

  async setCompensationReference(
    intentId: string,
    leaseId: string,
    providerReference: string,
  ): Promise<boolean> {
    const updated = await this.database.update(identitySessionIntents).set({
      providerReference,
      updatedAt: new Date(),
    }).where(and(
      eq(identitySessionIntents.id, intentId),
      eq(identitySessionIntents.status, "compensation_pending"),
      eq(identitySessionIntents.leaseId, leaseId),
    )).returning({ id: identitySessionIntents.id });
    return updated.length === 1;
  }

  async markCompensated(intentId: string, leaseId: string): Promise<boolean> {
    const updated = await this.database.update(identitySessionIntents).set({
      status: "compensated",
      lastError: null,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(identitySessionIntents.id, intentId),
      eq(identitySessionIntents.status, "compensation_pending"),
      eq(identitySessionIntents.leaseId, leaseId),
    )).returning({ id: identitySessionIntents.id });
    return updated.length === 1;
  }

  async recordRetry(
    intentId: string,
    status: "initiating" | "compensation_pending",
    attempts: number,
    errorCode: "IDENTITY_PROVIDER_FAILED" | "IDENTITY_COMPENSATION_FAILED",
    leaseId: string,
    now = new Date(),
  ): Promise<boolean> {
    const updated = await this.database.update(identitySessionIntents).set({
      status,
      attempts,
      availableAt: new Date(now.getTime() + Math.min(5 * 60_000, 1_000 * (2 ** attempts))),
      lastError: errorCode,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(and(
      eq(identitySessionIntents.id, intentId),
      eq(identitySessionIntents.status, status),
      eq(identitySessionIntents.leaseId, leaseId),
    )).returning({ id: identitySessionIntents.id });
    return updated.length === 1;
  }
}

export async function reconcileIdentitySessionIntents(input: {
  store: DrizzleIdentityAttemptStore;
  adapter: IdentityVerificationAdapter;
  now?: Date;
  leaseMs?: number;
}): Promise<number> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 30_000;
  const intents = await input.store.claimRecoverable(now, leaseMs);
  for (const intent of intents) {
    if (!intent.leaseId) continue;
    const leaseId = intent.leaseId;
    if (intent.status === "compensation_pending") {
      let providerReference = intent.providerReference;
      if (!providerReference) {
        let recovered: IdentityVerificationSession;
        try {
          recovered = await input.adapter.createSession({
            userId: intent.userId,
            idempotencyKey: intent.providerIdempotencyKey,
          });
        } catch {
          await input.store.recordRetry(
            intent.id,
            "compensation_pending",
            intent.attempts + 1,
            "IDENTITY_COMPENSATION_FAILED",
            leaseId,
            now,
          );
          continue;
        }
        const recorded = await input.store.setCompensationReference(
          intent.id,
          leaseId,
          recovered.providerReference,
        );
        if (!recorded) continue;
        providerReference = recovered.providerReference;
      }
      try {
        await input.adapter.cancelSession(providerReference);
        await input.store.markCompensated(intent.id, leaseId);
      } catch {
        await input.store.recordRetry(
          intent.id,
          "compensation_pending",
          intent.attempts + 1,
          "IDENTITY_COMPENSATION_FAILED",
          leaseId,
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
        leaseId,
        now,
      );
      continue;
    }
    try {
      await input.store.bindIntent(intent.id, hosted, leaseId);
    } catch (error) {
      if (error instanceof IdentityIntentLeaseLostError) continue;
      if (!(error instanceof IdentityAttemptConflictError)) throw error;
      try {
        await input.adapter.cancelSession(hosted.providerReference);
        await input.store.markCompensated(intent.id, leaseId);
      } catch {
        await input.store.recordRetry(
          intent.id,
          "compensation_pending",
          intent.attempts + 1,
          "IDENTITY_COMPENSATION_FAILED",
          leaseId,
          now,
        );
      }
    }
  }
  return intents.length;
}
