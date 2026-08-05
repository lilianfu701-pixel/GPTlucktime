import { and, desc, eq } from "drizzle-orm";

import { verificationAttempts, verificationWebhookEvents } from "@/db/schema";
import { db } from "@/infrastructure/db/client";
import {
  applyIdentityVerificationEvent,
  verifyIdentityWebhookSignature,
  type IdentityVerificationAttempt,
  type IdentityVerificationStatus,
  type IdentityVerificationWebhookEvent,
} from "@/modules/auth/identity-verification-adapter";
import { readEnv } from "@/shared/env";

const invalidSignature = () =>
  Response.json({ error: { code: "INVALID_SIGNATURE" } }, { status: 401 });
const invalidRequest = () =>
  Response.json({ error: { code: "INVALID_REQUEST" } }, { status: 400 });

function parseEvent(rawBody: string): IdentityVerificationWebhookEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "eventId,providerReference,status") return null;
  if (
    typeof value.eventId !== "string" || value.eventId.length < 1 || value.eventId.length > 200 ||
    typeof value.providerReference !== "string" || value.providerReference.length < 1 || value.providerReference.length > 500 ||
    (value.status !== "approved" && value.status !== "rejected" && value.status !== "expired")
  ) return null;
  return {
    eventId: value.eventId,
    providerReference: value.providerReference,
    status: value.status,
  };
}

function toAttempt(row: typeof verificationAttempts.$inferSelect | undefined): IdentityVerificationAttempt | null {
  if (!row?.userId || !row.providerReference) return null;
  return {
    id: row.id,
    userId: row.userId,
    providerReference: row.providerReference,
    status: row.status as IdentityVerificationStatus,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  const env = readEnv(process.env);
  const rawBody = await request.text();
  const signature = request.headers.get("x-verification-signature") ?? "";
  if (
    !env.IDENTITY_VERIFICATION_PROVIDER ||
    provider !== env.IDENTITY_VERIFICATION_PROVIDER ||
    !env.IDENTITY_VERIFICATION_WEBHOOK_SECRET ||
    !verifyIdentityWebhookSignature(rawBody, signature, env.IDENTITY_VERIFICATION_WEBHOOK_SECRET)
  ) return invalidSignature();

  const event = parseEvent(rawBody);
  if (!event) return invalidRequest();

  try {
    await db.transaction(async (transaction) => {
      await applyIdentityVerificationEvent({
        async reserveEvent(eventProvider, received) {
          const inserted = await transaction.insert(verificationWebhookEvents).values({
            provider: eventProvider,
            eventId: received.eventId,
            providerReference: received.providerReference,
          }).onConflictDoNothing({
            target: [verificationWebhookEvents.provider, verificationWebhookEvents.eventId],
          }).returning({ id: verificationWebhookEvents.id });
          return inserted.length === 1;
        },
        async findAttempt(eventProvider, providerReference) {
          const [row] = await transaction.select().from(verificationAttempts).where(and(
            eq(verificationAttempts.provider, eventProvider),
            eq(verificationAttempts.providerReference, providerReference),
            eq(verificationAttempts.kind, "identity"),
          )).limit(1);
          return toAttempt(row);
        },
        async findLatestAttempt(userId) {
          const [row] = await transaction.select().from(verificationAttempts).where(and(
            eq(verificationAttempts.userId, userId),
            eq(verificationAttempts.kind, "identity"),
          )).orderBy(desc(verificationAttempts.createdAt)).limit(1);
          return toAttempt(row);
        },
        async updateAttemptStatus(attemptId, status) {
          await transaction.update(verificationAttempts).set({ status, updatedAt: new Date() }).where(and(
            eq(verificationAttempts.id, attemptId),
            eq(verificationAttempts.status, "pending"),
          ));
        },
      }, provider, event);
    });
  } catch {
    return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
  }

  return Response.json({ received: true }, { status: 202 });
}
