import { createHmac, timingSafeEqual } from "node:crypto";

import {
  launchVerificationPolicy,
  type VerificationDecision,
  type VerificationPolicyInput,
  type VerificationRequestContext,
} from "./verification-policy";
import {
  IdentityAttemptConflictError,
  type DrizzleIdentityAttemptStore,
} from "./identity-attempt-store";

export const IDENTITY_PROVIDER_UNAVAILABLE = "IDENTITY_PROVIDER_UNAVAILABLE";
export const IDENTITY_PROVIDER_FAILED = "IDENTITY_PROVIDER_FAILED";

export type IdentityVerificationStatus = "pending" | "approved" | "rejected" | "expired";

export type CreateIdentityVerificationInput = {
  userId: string;
};

export type IdentityVerificationSession = {
  providerReference: string;
  redirectUrl: string;
  expiresAt: Date;
};

export type IdentityVerificationResult = { status: IdentityVerificationStatus };

export interface IdentityVerificationAdapter {
  createSession(input: CreateIdentityVerificationInput): Promise<IdentityVerificationSession>;
  getResult(providerReference: string): Promise<IdentityVerificationResult>;
  cancelSession(providerReference: string): Promise<void>;
}

type VendorConfig = { endpoint: string; apiKey: string; redirectOrigins: string[] };
const MAX_HOSTED_SESSION_MS = 30 * 60_000;

function isTrustedHostedSession(
  value: Record<string, unknown>,
  redirectOrigins: string[],
): value is { providerReference: string; redirectUrl: string; expiresAt: string } {
  if (
    typeof value.providerReference !== "string" ||
    value.providerReference.length < 1 ||
    value.providerReference.length > 500 ||
    typeof value.redirectUrl !== "string" ||
    value.redirectUrl.length > 2_048 ||
    typeof value.expiresAt !== "string"
  ) return false;
  try {
    const redirect = new URL(value.redirectUrl);
    const expiresAt = new Date(value.expiresAt).getTime();
    const now = Date.now();
    return redirect.protocol === "https:" &&
      !redirect.username &&
      !redirect.password &&
      redirectOrigins.includes(redirect.origin) &&
      Number.isFinite(expiresAt) &&
      expiresAt > now &&
      expiresAt <= now + MAX_HOSTED_SESSION_MS;
  } catch {
    return false;
  }
}

export class HttpsIdentityVerificationAdapter implements IdentityVerificationAdapter {
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    private readonly config?: VendorConfig,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {
    if (config && new URL(config.endpoint).protocol !== "https:") {
      throw new Error("IDENTITY_ENDPOINT_MUST_USE_HTTPS");
    }
    this.fetch = fetchImplementation;
  }

  async createSession(input: CreateIdentityVerificationInput): Promise<IdentityVerificationSession> {
    const value = await this.request("/sessions", { method: "POST", body: JSON.stringify(input) });
    if (!this.config || !isTrustedHostedSession(value, this.config.redirectOrigins)) {
      throw new Error(IDENTITY_PROVIDER_FAILED);
    }
    return {
      providerReference: value.providerReference,
      redirectUrl: value.redirectUrl,
      expiresAt: new Date(value.expiresAt),
    };
  }

  async getResult(providerReference: string): Promise<IdentityVerificationResult> {
    const value = await this.request(`/sessions/${encodeURIComponent(providerReference)}`, {
      method: "GET",
    });
    if (!["pending", "approved", "rejected", "expired"].includes(String(value.status))) {
      throw new Error(IDENTITY_PROVIDER_FAILED);
    }
    return { status: value.status as IdentityVerificationStatus };
  }

  async cancelSession(providerReference: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(providerReference)}`, { method: "DELETE" });
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    if (!this.config) throw new Error(IDENTITY_PROVIDER_UNAVAILABLE);
    try {
      const response = await this.fetch(`${this.config.endpoint.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(IDENTITY_PROVIDER_FAILED);
      return await response.json() as Record<string, unknown>;
    } catch {
      throw new Error(IDENTITY_PROVIDER_FAILED);
    }
  }
}

export class InMemoryIdentityVerificationAdapter implements IdentityVerificationAdapter {
  private readonly results = new Map<string, IdentityVerificationResult>();

  async createSession(input: CreateIdentityVerificationInput): Promise<IdentityVerificationSession> {
    void input;
    const providerReference = `test_${crypto.randomUUID()}`;
    this.results.set(providerReference, { status: "pending" });
    return {
      providerReference,
      redirectUrl: `https://identity.test/session/${providerReference}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
  }

  async getResult(providerReference: string): Promise<IdentityVerificationResult> {
    const result = this.results.get(providerReference);
    if (!result) throw new Error(IDENTITY_PROVIDER_FAILED);
    return result;
  }

  async cancelSession(providerReference: string): Promise<void> {
    if (!this.results.has(providerReference)) throw new Error(IDENTITY_PROVIDER_FAILED);
    this.results.set(providerReference, { status: "expired" });
  }
}

export function verifyIdentityWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string,
  secret: string,
): boolean {
  const suppliedHex = signature.startsWith("sha256=") ? signature.slice(7) : "";
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type IdentityVerificationAttempt = {
  id: string;
  userId: string;
  providerReference: string;
  status: IdentityVerificationStatus;
  expiresAt: Date;
  createdAt: Date;
};

export type IdentityVerificationWebhookEvent = {
  eventId: string;
  providerReference: string;
  status: Exclude<IdentityVerificationStatus, "pending">;
};

export interface IdentityVerificationEventStore {
  reserveEvent(provider: string, event: IdentityVerificationWebhookEvent): Promise<boolean>;
  findAttempt(provider: string, providerReference: string): Promise<IdentityVerificationAttempt | null>;
  findLatestAttempt(userId: string): Promise<IdentityVerificationAttempt | null>;
  linkEvent(provider: string, eventId: string, attemptId: string): Promise<void>;
  updateAttemptStatus(attemptId: string, status: IdentityVerificationStatus): Promise<void>;
}

export class IdentityVerificationAttemptNotFoundError extends Error {
  constructor() {
    super("IDENTITY_VERIFICATION_ATTEMPT_NOT_FOUND");
    this.name = "IdentityVerificationAttemptNotFoundError";
  }
}

export async function applyIdentityVerificationEvent(
  store: IdentityVerificationEventStore,
  provider: string,
  event: IdentityVerificationWebhookEvent,
  now = new Date(),
): Promise<"applied" | "ignored" | "duplicate"> {
  if (!await store.reserveEvent(provider, event)) return "duplicate";

  const attempt = await store.findAttempt(provider, event.providerReference);
  if (!attempt) throw new IdentityVerificationAttemptNotFoundError();
  await store.linkEvent(provider, event.eventId, attempt.id);
  if (attempt.status !== "pending" || attempt.expiresAt <= now) return "ignored";
  const latest = await store.findLatestAttempt(attempt.userId);
  if (!latest || latest.id !== attempt.id) return "ignored";

  await store.updateAttemptStatus(attempt.id, event.status);
  return "applied";
}

type IdentityHandlerSession = { user: { id: string } };

function handlerError(code: string, status: number): Response {
  return Response.json({ error: { code } }, { status });
}

function identityAction(body: unknown): VerificationPolicyInput["action"] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return null;
  return record.action === "browse" || record.action === "message" || record.action === "pay"
    ? record.action
    : null;
}

export function createIdentityVerificationHandler(input: {
  getSession(headers: Headers): Promise<IdentityHandlerSession | null>;
  getContext(userId: string): Promise<VerificationRequestContext>;
  adapter: IdentityVerificationAdapter;
  attemptStore: Pick<DrizzleIdentityAttemptStore, "findReusable" | "availability" | "create">;
  provider: string;
  providerConfigured?: boolean;
}) {
  return async function POST(request: Request): Promise<Response> {
    let session: IdentityHandlerSession | null;
    try {
      session = await input.getSession(request.headers);
    } catch {
      return handlerError("INTERNAL_ERROR", 500);
    }
    if (!session) return handlerError("UNAUTHORIZED", 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return handlerError("INVALID_REQUEST", 400);
    }
    const action = identityAction(body);
    if (!action) return handlerError("INVALID_REQUEST", 400);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!/^[\x21-\x7e]{8,200}$/.test(idempotencyKey)) {
      return handlerError("IDEMPOTENCY_KEY_REQUIRED", 400);
    }

    let context: VerificationRequestContext;
    let required: VerificationDecision;
    try {
      context = await input.getContext(session.user.id);
      required = await launchVerificationPolicy.decide({
        selfDeclaredCountryCode: context.selfDeclaredCountryCode,
        risk: context.risk,
        action,
      });
    } catch {
      return handlerError("INTERNAL_ERROR", 500);
    }
    if (!required.identity) return handlerError("IDENTITY_NOT_REQUIRED", 400);
    if (context.satisfied.identity) return handlerError("IDENTITY_ALREADY_VERIFIED", 409);
    if (input.providerConfigured === false) return handlerError(IDENTITY_PROVIDER_UNAVAILABLE, 503);

    try {
      const reusable = await input.attemptStore.findReusable(session.user.id, idempotencyKey);
      if (reusable) {
        return Response.json({
          redirectUrl: reusable.redirectUrl,
          expiresAt: reusable.expiresAt.toISOString(),
        });
      }
      const availability = await input.attemptStore.availability(session.user.id);
      if (availability === "pending") return handlerError("IDENTITY_ATTEMPT_PENDING", 409);
      if (availability === "cooldown") return handlerError("IDENTITY_ATTEMPT_COOLDOWN", 429);
    } catch {
      return handlerError("INTERNAL_ERROR", 500);
    }

    let hosted: IdentityVerificationSession;
    try {
      hosted = await input.adapter.createSession({ userId: session.user.id });
    } catch {
      return handlerError(IDENTITY_PROVIDER_UNAVAILABLE, 503);
    }
    try {
      await input.attemptStore.create({
        userId: session.user.id,
        provider: input.provider,
        providerReference: hosted.providerReference,
        idempotencyKey,
        redirectUrl: hosted.redirectUrl,
        expiresAt: hosted.expiresAt,
      });
    } catch (error) {
      await input.adapter.cancelSession(hosted.providerReference).catch(() => undefined);
      if (error instanceof IdentityAttemptConflictError) {
        const reusable = await input.attemptStore.findReusable(session.user.id, idempotencyKey)
          .catch(() => null);
        if (reusable) {
          return Response.json({
            redirectUrl: reusable.redirectUrl,
            expiresAt: reusable.expiresAt.toISOString(),
          });
        }
        return handlerError("IDENTITY_ATTEMPT_PENDING", 409);
      }
      return handlerError("INTERNAL_ERROR", 500);
    }

    return Response.json({ redirectUrl: hosted.redirectUrl, expiresAt: hosted.expiresAt.toISOString() });
  };
}
