import { createHash, randomUUID } from "node:crypto";

import { BillingError, type CheckoutService } from "./checkout-service";
import type { SubscriptionService } from "./subscription-service";
import type { WebhookService } from "./webhook-service";

type FieldError = { field: string; messageKey: string };
const messages: Record<string, string> = {
  METHOD_NOT_ALLOWED: "errors.methodNotAllowed",
  UNAUTHORIZED: "errors.unauthorized", INVALID_CHECKOUT: "errors.invalidCheckout",
  INVALID_IDEMPOTENCY_KEY: "errors.invalidIdempotencyKey", PRICE_NOT_AVAILABLE: "errors.priceNotAvailable",
  IDEMPOTENCY_CONFLICT: "errors.idempotencyConflict", RATE_LIMITED: "errors.rateLimited",
  PAYLOAD_TOO_LARGE: "errors.payloadTooLarge", UNSUPPORTED_MEDIA_TYPE: "errors.unsupportedMediaType",
  INVALID_SIGNATURE: "errors.invalidSignature", INVALID_QUERY: "errors.invalidQuery",
  PROVIDER_UNAVAILABLE: "errors.serviceUnavailable", INTERNAL_ERROR: "errors.internal",
  FORBIDDEN: "errors.forbidden", SUBSCRIPTION_NOT_AVAILABLE: "errors.subscriptionNotAvailable",
  CHECKOUT_NOT_AVAILABLE: "errors.checkoutNotAvailable", PAY_VERIFICATION_REQUIRED: "errors.payVerificationRequired",
};
const retryable = new Set(["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "INTERNAL_ERROR"]);
const tracePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const traceId = (request: Request, create: () => string) => {
  const provided = request.headers.get("x-request-id")?.trim();
  return provided && tracePattern.test(provided) ? provided.toLowerCase() : create();
};
const errorResponse = (code: string, status: number, trace: string, fields?: FieldError[], headers?: HeadersInit) =>
  Response.json({ code, messageKey: messages[code] ?? messages.INTERNAL_ERROR, retryable: retryable.has(code), traceId: trace,
    ...(fields ? { fieldErrors: fields } : {}) }, { status, headers: { ...Object.fromEntries(new Headers(headers)), "x-trace-id": trace } });

class RequestBodyError extends Error {
  constructor(readonly code: "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "INVALID_CHECKOUT") { super(code); }
}

async function boundedBody(request: Request, maxBytes: number, requireJson: boolean) {
  if (requireJson && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? "")) {
    throw new RequestBodyError("UNSUPPORTED_MEDIA_TYPE");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    throw new RequestBodyError("PAYLOAD_TOO_LARGE");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new RequestBodyError("PAYLOAD_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

const mapBilling = (error: unknown, trace: string) => {
  if (error instanceof RequestBodyError) {
    const status = error.code === "PAYLOAD_TOO_LARGE" ? 413 : error.code === "UNSUPPORTED_MEDIA_TYPE" ? 415 : 400;
    return errorResponse(error.code, status, trace, [{ field: "body", messageKey: messages[error.code]! }]);
  }
  if (error instanceof BillingError) {
    if (error.code === "INVALID_CHECKOUT") return errorResponse(error.code, 400, trace,
      [{ field: "body", messageKey: messages.INVALID_CHECKOUT! }]);
    if (error.code === "PRICE_NOT_AVAILABLE" || error.code === "CUSTOMER_NOT_AVAILABLE") {
      return errorResponse("PRICE_NOT_AVAILABLE", 404, trace);
    }
    if (error.code === "IDEMPOTENCY_CONFLICT") return errorResponse(error.code, 409, trace);
    if (error.code === "CHECKOUT_NOT_AVAILABLE") return errorResponse(error.code, 409, trace);
    if (error.code === "PROVIDER_UNAVAILABLE") return errorResponse(error.code, 503, trace);
    if (error.code === "SUBSCRIPTION_NOT_AVAILABLE") return errorResponse(error.code, 404, trace);
    if (error.code === "INVALID_SIGNATURE") return errorResponse(error.code, 400, trace);
  }
  return errorResponse("INTERNAL_ERROR", 500, trace);
};

export function createCheckoutHandler(deps: {
  getSession(headers: Headers): Promise<{ user: { id: string } } | null>;
  authorizePayment(userId: string): Promise<{ countryCode: string } | null>;
  service: Pick<CheckoutService, "create">;
  limiter: { consume(input: { userId: string; key: "billing.checkout" }): Promise<{ allowed: boolean; retryAfterSeconds: number }> };
  createTraceId?: () => string;
}) {
  return async (request: Request) => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    let session: { user: { id: string } } | null;
    try { session = await deps.getSession(request.headers); } catch { return errorResponse("INTERNAL_ERROR", 500, trace); }
    if (!session) return errorResponse("UNAUTHORIZED", 401, trace);
    let authorization: { countryCode: string } | null;
    try {
      authorization = await deps.authorizePayment(session.user.id);
      if (!authorization) return errorResponse("PAY_VERIFICATION_REQUIRED", 403, trace);
    } catch { return errorResponse("PAY_VERIFICATION_REQUIRED", 403, trace); }
    let limit;
    try { limit = await deps.limiter.consume({ userId: session.user.id, key: "billing.checkout" }); } catch {
      return errorResponse("PROVIDER_UNAVAILABLE", 503, trace);
    }
    if (!limit.allowed) return errorResponse("RATE_LIMITED", 429, trace, undefined,
      { "retry-after": String(Math.max(1, Math.min(86_400, Math.ceil(limit.retryAfterSeconds)))) });
    const key = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(key)) {
      return errorResponse("INVALID_IDEMPOTENCY_KEY", 400, trace,
        [{ field: "idempotency-key", messageKey: messages.INVALID_IDEMPOTENCY_KEY! }]);
    }
    try {
      const bytes = await boundedBody(request, 16_384, true);
      let json: unknown;
      try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new RequestBodyError("INVALID_CHECKOUT"); }
      const result = await deps.service.create(session.user.id, json, key, authorization.countryCode);
      return Response.json(result, { status: result.replayed ? 200 : 201, headers: { "x-trace-id": trace } });
    } catch (error) { return mapBilling(error, trace); }
  };
}

export function createSubscriptionHandler(deps: {
  getSession(headers: Headers): Promise<{ user: { id: string; emailVerified: boolean } } | null>;
  service: Pick<SubscriptionService, "get" | "update">;
  limiter: { consume(input: { userId: string; key: "billing.subscription.manage" }): Promise<{
    allowed: boolean; retryAfterSeconds: number;
  }> };
  createTraceId?: () => string;
}) {
  return async (request: Request) => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "GET" && request.method !== "PATCH") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    let session: { user: { id: string; emailVerified: boolean } } | null;
    try { session = await deps.getSession(request.headers); } catch { return errorResponse("INTERNAL_ERROR", 500, trace); }
    if (!session) return errorResponse("UNAUTHORIZED", 401, trace);
    if (request.method === "GET") {
      try { return Response.json({ subscription: await deps.service.get(session.user.id) },
        { headers: { "cache-control": "private, no-store", "x-trace-id": trace } }); } catch (error) {
        return mapBilling(error, trace);
      }
    }
    if (!session.user.emailVerified) return errorResponse("FORBIDDEN", 403, trace);
    let limit;
    try { limit = await deps.limiter.consume({ userId: session.user.id, key: "billing.subscription.manage" }); } catch {
      return errorResponse("PROVIDER_UNAVAILABLE", 503, trace);
    }
    if (!limit.allowed) return errorResponse("RATE_LIMITED", 429, trace, undefined,
      { "retry-after": String(Math.max(1, Math.min(86_400, Math.ceil(limit.retryAfterSeconds)))) });
    const key = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(key)) {
      return errorResponse("INVALID_IDEMPOTENCY_KEY", 400, trace,
        [{ field: "idempotency-key", messageKey: messages.INVALID_IDEMPOTENCY_KEY! }]);
    }
    try {
      const bytes = await boundedBody(request, 4_096, true);
      let json: unknown;
      try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
        throw new RequestBodyError("INVALID_CHECKOUT");
      }
      const result = await deps.service.update(session.user.id, json, key);
      return Response.json(result, { status: 202, headers: { "cache-control": "private, no-store", "x-trace-id": trace } });
    } catch (error) { return mapBilling(error, trace); }
  };
}

export function createPlansHandler(deps: {
  list(input: { countryCode: string; currency: string; limit: number; after?: string; now: Date }): Promise<unknown[]>;
  createTraceId?: () => string;
}) {
  return async (request: Request) => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    const search = new URL(request.url).searchParams;
    for (const key of search.keys()) if (!["country", "currency", "limit", "after"].includes(key) || search.getAll(key).length !== 1) {
      return errorResponse("INVALID_QUERY", 400, trace, [{ field: key, messageKey: messages.INVALID_QUERY! }]);
    }
    const countryCode = search.get("country") ?? "";
    const currency = search.get("currency") ?? "";
    const limit = Number(search.get("limit") ?? "20");
    const afterRaw = search.get("after") ?? undefined;
    const after = afterRaw === undefined ? undefined : decodePlanCursor(afterRaw);
    if (!/^[A-Z]{2}$/u.test(countryCode) || !/^[A-Z]{3}$/u.test(currency)
      || !Number.isInteger(limit) || limit < 1 || limit > 20
      || (afterRaw !== undefined && !after)) {
      return errorResponse("INVALID_QUERY", 400, trace, [{ field: "query", messageKey: messages.INVALID_QUERY! }]);
    }
    try {
      const raw = await deps.list({ countryCode, currency, limit: limit + 1,
        ...(after ? { after: after.planRef } : {}), now: new Date() });
      const safe = raw.flatMap((value) => safePublicPlan(value));
      const page = safe.slice(0, limit);
      const plans = page.map((item) => item.plan);
      const nextCursor = safe.length > limit && page.length ? encodePlanCursor(page.at(-1)!) : null;
      return Response.json({ plans, nextCursor },
      { headers: { "cache-control": "public, max-age=60", "x-trace-id": trace } }); } catch {
      return errorResponse("INTERNAL_ERROR", 500, trace);
    }
  };
}

const safePublicPlan = (value: unknown) => {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const price = (row.price && typeof row.price === "object" ? row.price : row) as Record<string, unknown>;
  const nameKey = row.nameKey ?? row.planNameKey;
  const descriptionKey = row.descriptionKey ?? row.planDescriptionKey;
  if (typeof row.planRef !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(row.planRef)
    || typeof nameKey !== "string" || nameKey.length > 120
    || typeof descriptionKey !== "string" || descriptionKey.length > 120
    || typeof price.currency !== "string" || !/^[A-Z]{3}$/u.test(price.currency)
    || typeof price.unitAmount !== "number" || !Number.isSafeInteger(price.unitAmount) || price.unitAmount < 0
    || !(["monthly", "quarterly", "yearly"] as unknown[]).includes(price.interval)
    || typeof price.intervalCount !== "number" || !Number.isInteger(price.intervalCount)
    || !(["inclusive", "exclusive"] as unknown[]).includes(price.taxMode)) return [];
  const offerKey = createHash("sha256").update(JSON.stringify({ planRef: row.planRef,
    planVersion: row.planVersion ?? 0, priceVersion: row.priceVersion ?? 0, id: row.id ?? "public" })).digest("hex").slice(0, 16);
  return [{ plan: { planRef: row.planRef, nameKey, descriptionKey,
    price: { currency: price.currency, unitAmount: price.unitAmount, interval: price.interval,
      intervalCount: price.intervalCount, taxMode: price.taxMode } }, planRef: row.planRef, offerKey }];
};

const encodePlanCursor = (input: { planRef: string; offerKey: string }) =>
  Buffer.from(JSON.stringify({ p: input.planRef, k: input.offerKey }), "utf8").toString("base64url");

const decodePlanCursor = (value: string) => {
  if (value.length < 8 || value.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(",") !== "k,p" || typeof parsed.p !== "string"
      || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(parsed.p) || typeof parsed.k !== "string"
      || !/^[a-f0-9]{16}$/u.test(parsed.k)) return null;
    return { planRef: parsed.p, offerKey: parsed.k };
  } catch { return null; }
};

export function createStripeWebhookHandler(deps: { service: Pick<WebhookService, "handle">; createTraceId?: () => string }) {
  return async (request: Request) => {
    const trace = traceId(request, deps.createTraceId ?? randomUUID);
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405, trace);
    const signature = request.headers.get("stripe-signature")?.trim();
    if (!signature || signature.length > 8_192) return errorResponse("INVALID_SIGNATURE", 400, trace);
    try {
      const raw = await boundedBody(request, 262_144, false);
      const result = await deps.service.handle(raw, signature);
      return Response.json(result, { status: 200, headers: { "x-trace-id": trace } });
    } catch (error) { return mapBilling(error, trace); }
  };
}
