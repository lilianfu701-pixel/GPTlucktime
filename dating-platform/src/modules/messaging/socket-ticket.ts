import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import { profiles, sessions } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";
import type { ModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";

const TICKET_TTL_SECONDS = 300;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type SocketTicketKeyRing = {
  active: { kid: string; secret: Buffer };
  byKid: ReadonlyMap<string, Buffer>;
};

const invalidConfig = (): never => { throw new Error("REALTIME_TICKET_KEYS_INVALID"); };
const invalidTicket = (): never => { throw new Error("INVALID_SOCKET_TICKET"); };

function decodeBase64UrlStrict(value: string, maxLength: number) {
  if (!value || value.length > maxLength || !BASE64URL_PATTERN.test(value)) invalidTicket();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) invalidTicket();
  return decoded;
}

export function parseSocketTicketKeyRing(value: string): SocketTicketKeyRing {
  if (!value || value.length > 8192) invalidConfig();
  const byKid = new Map<string, Buffer>();
  let active: { kid: string; secret: Buffer } | undefined;
  for (const rawEntry of value.split(",")) {
    const separator = rawEntry.indexOf(":");
    if (separator < 1 || rawEntry.indexOf(":", separator + 1) !== -1) invalidConfig();
    const kid = rawEntry.slice(0, separator);
    const encoded = rawEntry.slice(separator + 1);
    if (!KID_PATTERN.test(kid) || !BASE64URL_PATTERN.test(encoded) || byKid.has(kid)) invalidConfig();
    const secret = Buffer.from(encoded, "base64url");
    if (secret.length < 32 || secret.length > 128 || secret.toString("base64url") !== encoded) invalidConfig();
    byKid.set(kid, secret);
    active ??= { kid, secret };
  }
  if (!active) throw new Error("REALTIME_TICKET_KEYS_INVALID");
  if (byKid.size === 0 || byKid.size > 8) invalidConfig();
  return { active, byKid };
}

function encodedJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signSocketTicket(
  input: { sub: string; sessionId: string },
  keys: SocketTicketKeyRing,
  now = new Date(),
) {
  if (!UUID_PATTERN.test(input.sub) || !UUID_PATTERN.test(input.sessionId) || Number.isNaN(now.getTime())) {
    invalidTicket();
  }
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const exp = issuedAtSeconds + TICKET_TTL_SECONDS;
  const header = encodedJson({ alg: "HS256", kid: keys.active.kid, typ: "JWT" });
  const payload = encodedJson({ sub: input.sub, sessionId: input.sessionId, aud: "realtime", exp });
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", keys.active.secret).update(signingInput).digest("base64url");
  return {
    ticket: `${signingInput}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");

function parseObject(segment: string) {
  try {
    const value = JSON.parse(decodeBase64UrlStrict(segment, 2048).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidTicket();
    const record = value as Record<string, unknown>;
    if (encodedJson(record) !== segment) invalidTicket();
    return record;
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_SOCKET_TICKET") throw error;
    return invalidTicket();
  }
}

export type VerifiedSocketTicket = {
  sub: string;
  sessionId: string;
  aud: "realtime";
  exp: number;
  issuedAt: Date;
};

export function verifySocketTicket(
  token: string,
  keys: SocketTicketKeyRing,
  now = new Date(),
): VerifiedSocketTicket {
  if (!token || token.length > 4096 || Number.isNaN(now.getTime())) invalidTicket();
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) invalidTicket();
  const header = parseObject(encodedHeader);
  if (!exactKeys(header, ["alg", "kid", "typ"])
    || header.alg !== "HS256" || header.typ !== "JWT"
    || typeof header.kid !== "string" || !KID_PATTERN.test(header.kid)) invalidTicket();
  const kid = header.kid as string;
  const secret = keys.byKid.get(kid);
  if (!secret) throw new Error("INVALID_SOCKET_TICKET");
  const supplied = decodeBase64UrlStrict(encodedSignature, 128);
  const expected = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalidTicket();

  const payload = parseObject(encodedPayload);
  if (!exactKeys(payload, ["sub", "sessionId", "aud", "exp"])
    || typeof payload.sub !== "string" || !UUID_PATTERN.test(payload.sub)
    || typeof payload.sessionId !== "string" || !UUID_PATTERN.test(payload.sessionId)
    || payload.aud !== "realtime"
    || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)) invalidTicket();
  const exp = payload.exp as number;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const issuedAtSeconds = exp - TICKET_TTL_SECONDS;
  if (issuedAtSeconds > nowSeconds || exp <= nowSeconds) invalidTicket();
  return {
    sub: payload.sub as string,
    sessionId: payload.sessionId as string,
    aud: "realtime" as const,
    exp,
    issuedAt: new Date(issuedAtSeconds * 1000),
  };
}

type TicketDatabase = typeof productionDatabase;

export class DrizzleSocketTicketIssuer {
  private readonly database: TicketDatabase;
  private readonly clock: () => Date;
  private readonly restrictionPolicy: ModerationRestrictionPolicy;

  constructor(
    database: unknown,
    private readonly keys: SocketTicketKeyRing,
    options: { clock?: () => Date; restrictionPolicy: ModerationRestrictionPolicy },
  ) {
    this.database = database as TicketDatabase;
    this.clock = options.clock ?? (() => new Date());
    this.restrictionPolicy = options.restrictionPolicy;
  }

  async issue(userId: string, sessionId: string) {
    if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(sessionId)) {
      throw new Error("REALTIME_SESSION_NOT_AVAILABLE");
    }
    const now = this.clock();
    const [eligible] = await this.database.select({ id: sessions.id }).from(sessions)
      .innerJoin(profiles, eq(profiles.userId, sessions.userId))
      .where(and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        gt(sessions.expiresAt, now),
        eq(profiles.status, "active"),
      )).limit(1);
    if (!eligible) throw new Error("REALTIME_SESSION_NOT_AVAILABLE");
    const allowed = await this.restrictionPolicy.filterAllowedInTransaction(
      this.database, [userId], "messaging", now,
    );
    if (!allowed.has(userId)) throw new Error("REALTIME_SESSION_NOT_AVAILABLE");
    return signSocketTicket({ sub: userId, sessionId }, this.keys, now);
  }
}
