import "server-only";

import { and, eq } from "drizzle-orm";

import { profiles, users, verificationAttempts } from "@/db/schema";
import { db } from "@/infrastructure/db/client";

import type {
  VerificationContextRepository,
  VerificationRequestContext,
} from "./verification-policy";

export class DrizzleVerificationContextRepository implements VerificationContextRepository {
  async get(userId: string): Promise<VerificationRequestContext> {
    const [account] = await db
      .select({
        emailVerified: users.emailVerified,
        phoneVerified: users.phoneNumberVerified,
        selfDeclaredCountryCode: profiles.countryCode,
        profileStatus: profiles.status,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);

    if (!account) throw new Error("AUTH_CONTEXT_NOT_FOUND");
    const approved = await db
      .select({ kind: verificationAttempts.kind })
      .from(verificationAttempts)
      .where(and(
        eq(verificationAttempts.userId, userId),
        eq(verificationAttempts.status, "approved"),
      ));
    const approvedKinds = new Set(approved.map(({ kind }) => kind));
    const highRiskStatuses = new Set(["restricted", "suspended", "banned"]);

    return {
      selfDeclaredCountryCode: account.selfDeclaredCountryCode ?? "ZZ",
      risk: account.profileStatus && highRiskStatuses.has(account.profileStatus) ? "high" : "medium",
      satisfied: {
        email: account.emailVerified,
        phone: account.phoneVerified,
        liveness: approvedKinds.has("liveness"),
        identity: approvedKinds.has("identity"),
      },
    };
  }
}

export const verificationContextRepository = new DrizzleVerificationContextRepository();
