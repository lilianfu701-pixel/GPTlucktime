import { and, desc, eq, lte } from "drizzle-orm";

import { verificationAttempts, verificationWebhookEvents } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

import {
  applyIdentityVerificationEvent,
  IdentityVerificationAttemptNotFoundError,
  verifyIdentityWebhookSignature,
  type IdentityVerificationAttempt,
  type IdentityVerificationStatus,
  type IdentityVerificationWebhookEvent,
} from "./identity-verification-adapter";

export type VerificationDatabase = typeof productionDatabase;
export const VERIFICATION_WEBHOOK_RETENTION_MS = 30 * 24 * 60 * 60_000;

export async function cleanupIdentityVerificationWebhookEvents(
  database: VerificationDatabase,
  now = new Date(),
  retentionMs = VERIFICATION_WEBHOOK_RETENTION_MS,
): Promise<number> {
  const removed = await database.delete(verificationWebhookEvents).where(lte(
    verificationWebhookEvents.receivedAt,
    new Date(now.getTime() - retentionMs),
  )).returning({ id: verificationWebhookEvents.id });
  return removed.length;
}

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

function toAttempt(
  row: typeof verificationAttempts.$inferSelect | undefined,
): IdentityVerificationAttempt | null {
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

export async function processIdentityVerificationWebhook(
  database: VerificationDatabase,
  provider: string,
  event: IdentityVerificationWebhookEvent,
  now = new Date(),
): Promise<"applied" | "ignored" | "duplicate"> {
  return database.transaction(async (transaction) => applyIdentityVerificationEvent({
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
    async linkEvent(eventProvider, eventId, attemptId) {
      await transaction.update(verificationWebhookEvents).set({ attemptId }).where(and(
        eq(verificationWebhookEvents.provider, eventProvider),
        eq(verificationWebhookEvents.eventId, eventId),
      ));
    },
    async updateAttemptStatus(attemptId, status) {
      await transaction.update(verificationAttempts).set({
        status,
        updatedAt: new Date(),
      }).where(and(
        eq(verificationAttempts.id, attemptId),
        eq(verificationAttempts.status, "pending"),
      ));
    },
  }, provider, event, now));
}

export function createIdentityVerificationWebhookHandler(input: {
  provider: string | undefined;
  secret: string | undefined;
  processEvent(
    provider: string,
    event: IdentityVerificationWebhookEvent,
  ): Promise<unknown>;
}) {
  return async function handle(request: Request, provider: string): Promise<Response> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 65_536) return invalidRequest();
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.byteLength > 65_536) return invalidRequest();
    const signature = request.headers.get("x-verification-signature") ?? "";
    if (
      !input.provider ||
      provider !== input.provider ||
      !input.secret ||
      !verifyIdentityWebhookSignature(rawBody, signature, input.secret)
    ) return invalidSignature();

    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    } catch {
      return invalidRequest();
    }
    const event = parseEvent(decoded);
    if (!event) return invalidRequest();

    try {
      await input.processEvent(provider, event);
    } catch (error) {
      if (error instanceof IdentityVerificationAttemptNotFoundError) {
        return Response.json(
          { error: { code: "IDENTITY_VERIFICATION_ATTEMPT_NOT_READY" } },
          { status: 503, headers: { "retry-after": "1" } },
        );
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }
    return Response.json({ received: true }, { status: 202 });
  };
}
