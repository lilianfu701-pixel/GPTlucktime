import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import {
  createIdentityVerificationHandler,
  HttpsIdentityVerificationAdapter,
} from "@/modules/auth/identity-verification-adapter";
import { verificationContextRepository } from "@/modules/auth/verification-context-repository";
import {
  DrizzleIdentityAttemptStore,
  reconcileIdentitySessionIntents,
} from "@/modules/auth/identity-attempt-store";
import { EncryptionKeyRing, StableHmac, parseEncryptionKeyRing } from "@/modules/auth/auth-crypto";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const provider = env.IDENTITY_VERIFICATION_PROVIDER ?? "unconfigured";
const adapter = new HttpsIdentityVerificationAdapter(
  env.IDENTITY_VERIFICATION_URL && env.IDENTITY_VERIFICATION_API_KEY
    && env.IDENTITY_REDIRECT_ORIGINS
    ? {
        endpoint: env.IDENTITY_VERIFICATION_URL,
        apiKey: env.IDENTITY_VERIFICATION_API_KEY,
        redirectOrigins: env.IDENTITY_REDIRECT_ORIGINS.split(","),
      }
    : undefined,
);
const attemptStore = env.AUTH_ENCRYPTION_KEYS && env.IDENTITY_IDEMPOTENCY_HMAC_KEY
  ? new DrizzleIdentityAttemptStore(
      db,
      new EncryptionKeyRing(parseEncryptionKeyRing(env.AUTH_ENCRYPTION_KEYS)),
      new StableHmac(env.IDENTITY_IDEMPOTENCY_HMAC_KEY),
    )
  : undefined;

export const POST = createIdentityVerificationHandler({
  getSession: (headers) => auth.api.getSession({ headers }),
  getContext: (userId) => verificationContextRepository.get(userId),
  adapter,
  provider,
  providerConfigured: Boolean(attemptStore && env.IDENTITY_VERIFICATION_URL),
  attemptStore: attemptStore ?? {
    async findReusable() { throw new Error("IDENTITY_PROVIDER_UNAVAILABLE"); },
    async availability() { throw new Error("IDENTITY_PROVIDER_UNAVAILABLE"); },
    async beginIntent() { throw new Error("IDENTITY_PROVIDER_UNAVAILABLE"); },
    async bindIntent() { throw new Error("IDENTITY_PROVIDER_UNAVAILABLE"); },
    async markCompensated() { throw new Error("IDENTITY_PROVIDER_UNAVAILABLE"); },
    async recordRetry() { throw new Error("IDENTITY_PROVIDER_UNAVAILABLE"); },
  },
});

export const runIdentitySessionRecoveryWorker = () => attemptStore
  ? reconcileIdentitySessionIntents({ store: attemptStore, adapter })
  : Promise.resolve(0);
