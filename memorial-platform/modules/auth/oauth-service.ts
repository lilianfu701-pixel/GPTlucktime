import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { emailCredentials, userIdentities, users } from "@/db/schema";
import type { AccountLinkDecision, SocialProvider } from "./providers/oauth";
import { decideAccountLink } from "./providers/oauth";
import { createSession } from "./sessions";

export async function signInWithSocialProvider(input: {
  provider: SocialProvider;
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
  locale: string;
  ipHash?: string | undefined;
  userAgent?: string | undefined;
}): Promise<{ userId: string; token: string; expiresAt: Date }> {
  const [identity] = await db()
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, input.provider),
        eq(userIdentities.providerSubject, input.providerSubject),
      ),
    );

  let emailOwnerUserId: string | null = null;
  if (input.email) {
    const [emailOwner] = await db()
      .select({ userId: emailCredentials.userId })
      .from(emailCredentials)
      .where(eq(emailCredentials.email, input.email.toLowerCase().trim()));
    emailOwnerUserId = emailOwner?.userId ?? null;
  }

  const decision = decideAccountLink({
    identityUserId: identity?.userId ?? null,
    emailOwnerUserId,
    email: input.email,
    emailVerified: input.emailVerified,
  });

  const userId = await executeDecision(decision, input);

  const session = await createSession({
    userId,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
  });

  return { userId, token: session.token, expiresAt: session.expiresAt };
}

async function executeDecision(
  decision: AccountLinkDecision,
  input: {
    provider: SocialProvider;
    providerSubject: string;
    email: string | null;
    emailVerified: boolean;
    locale: string;
  },
): Promise<string> {
  switch (decision.kind) {
    case "sign_in_existing_identity":
      return decision.userId;

    case "link_existing_account":
      await db().insert(userIdentities).values({
        userId: decision.userId,
        provider: input.provider,
        providerSubject: input.providerSubject,
        verifiedAt: new Date(),
      });
      return decision.userId;

    case "manual_link_required":
      return createSocialAccount(input);

    case "create_account":
      return createSocialAccount(input);
  }
}

async function createSocialAccount(input: {
  provider: SocialProvider;
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
  locale: string;
}): Promise<string> {
  return db().transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ preferredLocale: input.locale })
      .returning({ id: users.id });

    if (!user) {
      throw new Error("user insert returned no row");
    }

    await tx.insert(userIdentities).values({
      userId: user.id,
      provider: input.provider,
      providerSubject: input.providerSubject,
      verifiedAt: new Date(),
    });

    if (input.email && input.emailVerified) {
      await tx
        .insert(emailCredentials)
        .values({
          userId: user.id,
          email: input.email.toLowerCase().trim(),
          verifiedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    return user.id;
  });
}
