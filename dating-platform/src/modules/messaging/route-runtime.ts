import "server-only";

import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { entitlementService } from "@/modules/entitlements/runtime";
import { SocialRepository } from "@/modules/social/social-repository";
import { DrizzleModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";
import { DrizzleModerationContentPolicy } from "@/modules/moderation/content-policy";
import { readEnv } from "@/shared/env";

import { DrizzleMessageVerificationPolicy, MessageRepository } from "./message-repository";
import { MessageReceiptRepository } from "./message-receipt-repository";
import { MessageReceiptService } from "./message-receipt-service";
import { DrizzleSocketTicketIssuer, parseSocketTicketKeyRing } from "./socket-ticket";

const env = readEnv(process.env);
const socialRepository = new SocialRepository(db, {
  cursorSecret: env.BETTER_AUTH_SECRET,
  idempotencySecret: env.BETTER_AUTH_SECRET,
});
const receiptRepository = new MessageReceiptRepository(db, { interactionPolicy: socialRepository });

export const messagingRouteDependencies = {
  getSession: async (headers: Headers) => {
    const session = await auth.api.getSession({ headers });
    return session ? {
      user: { id: session.user.id },
      session: { id: session.session.id },
    } : null;
  },
  repository: new MessageRepository(db, {
    interactionPolicy: socialRepository,
    entitlementService,
    verificationPolicy: new DrizzleMessageVerificationPolicy(),
    restrictionPolicy: new DrizzleModerationRestrictionPolicy(),
    contentPolicy: new DrizzleModerationContentPolicy(),
    cursorSecret: env.BETTER_AUTH_SECRET,
  }),
  issuer: env.REALTIME_TICKET_KEYS
    ? new DrizzleSocketTicketIssuer(db, parseSocketTicketKeyRing(env.REALTIME_TICKET_KEYS))
    : null,
  receipts: new MessageReceiptService(receiptRepository, entitlementService),
};
