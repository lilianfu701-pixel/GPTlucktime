import { and, eq } from "drizzle-orm";

import { verificationAttempts } from "@/db/schema";
import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import {
  createIdentityVerificationHandler,
  HttpsIdentityVerificationAdapter,
} from "@/modules/auth/identity-verification-adapter";
import { verificationContextRepository } from "@/modules/auth/verification-context-repository";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const provider = env.IDENTITY_VERIFICATION_PROVIDER ?? "unconfigured";
const adapter = new HttpsIdentityVerificationAdapter(
  env.IDENTITY_VERIFICATION_URL && env.IDENTITY_VERIFICATION_API_KEY
    ? { endpoint: env.IDENTITY_VERIFICATION_URL, apiKey: env.IDENTITY_VERIFICATION_API_KEY }
    : undefined,
);

export const POST = createIdentityVerificationHandler({
  getSession: (headers) => auth.api.getSession({ headers }),
  getContext: (userId) => verificationContextRepository.get(userId),
  adapter,
  provider,
  async createAttempt(attempt) {
    await db.transaction(async (transaction) => {
      await transaction
        .update(verificationAttempts)
        .set({ status: "expired", updatedAt: new Date() })
        .where(and(
          eq(verificationAttempts.userId, attempt.userId),
          eq(verificationAttempts.kind, "identity"),
          eq(verificationAttempts.status, "pending"),
        ));
      await transaction.insert(verificationAttempts).values({
        userId: attempt.userId,
        kind: "identity",
        provider: attempt.provider,
        providerReference: attempt.providerReference,
        status: "pending",
        expiresAt: attempt.expiresAt,
      });
    });
  },
});
