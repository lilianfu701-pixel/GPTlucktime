// @vitest-environment node

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseSocketTicketKeyRing,
  signSocketTicket,
  verifySocketTicket,
} from "@/modules/messaging/socket-ticket";

const activeSecret = Buffer.alloc(32, 7).toString("base64url");
const oldSecret = Buffer.alloc(32, 9).toString("base64url");
const keys = parseSocketTicketKeyRing(`active:${activeSecret},old:${oldSecret}`);
const now = new Date("2026-08-08T12:00:00.000Z");
const subject = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const manuallySign = (header: unknown, payload: unknown, secret = activeSecret) => {
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
};
const nonCanonicalTail = (segment: string) => {
  const bytes = Buffer.from(segment, "base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const replacement of alphabet) {
    const candidate = `${segment.slice(0, -1)}${replacement}`;
    if (candidate !== segment && Buffer.from(candidate, "base64url").equals(bytes)) return candidate;
  }
  throw new Error("test segment has no unused base64url tail bits");
};

describe("socket ticket", () => {
  it("signs a five-minute minimal ticket and verifies active and old rotating keys", () => {
    const signed = signSocketTicket({ sub: subject, sessionId }, keys, now);
    expect(signed.expiresAt).toBe("2026-08-08T12:05:00.000Z");
    expect(verifySocketTicket(signed.ticket, keys, now)).toEqual({
      sub: subject,
      sessionId,
      aud: "realtime",
      exp: Math.floor(now.getTime() / 1000) + 300,
      issuedAt: now,
    });

    const oldTicket = manuallySign(
      { alg: "HS256", kid: "old", typ: "JWT" },
      { sub: subject, sessionId, aud: "realtime", exp: Math.floor(now.getTime() / 1000) + 300 },
      oldSecret,
    );
    expect(verifySocketTicket(oldTicket, keys, now).sub).toBe(subject);
  });

  it("rejects missing, duplicate, malformed, or short keys", () => {
    expect(() => parseSocketTicketKeyRing("")).toThrow("REALTIME_TICKET_KEYS_INVALID");
    expect(() => parseSocketTicketKeyRing(`same:${activeSecret},same:${oldSecret}`))
      .toThrow("REALTIME_TICKET_KEYS_INVALID");
    expect(() => parseSocketTicketKeyRing("bad:not-base64!"))
      .toThrow("REALTIME_TICKET_KEYS_INVALID");
    expect(() => parseSocketTicketKeyRing(`short:${Buffer.alloc(31).toString("base64url")}`))
      .toThrow("REALTIME_TICKET_KEYS_INVALID");
  });

  it("strictly rejects wrong headers, payload additions, audience, timing, and tampering", () => {
    const exp = Math.floor(now.getTime() / 1000) + 300;
    const payload = { sub: subject, sessionId, aud: "realtime", exp };
    const header = { alg: "HS256", kid: "active", typ: "JWT" };
    for (const ticket of [
      manuallySign({ ...header, alg: "none" }, payload),
      manuallySign({ ...header, typ: "JOSE" }, payload),
      manuallySign({ ...header, extra: true }, payload),
      manuallySign({ ...header, kid: "missing" }, payload),
      manuallySign(header, { ...payload, aud: "api" }),
      manuallySign(header, { ...payload, role: "admin" }),
      manuallySign(header, { ...payload, exp: exp + 1 }),
      manuallySign(header, { ...payload, exp: exp - 301 }),
      manuallySign(header, { ...payload, sub: "not-a-uuid" }),
      (() => {
        const rawHeader = Buffer.from('{"alg":"HS256","kid":"active","typ":"JWT","alg":"HS256"}')
          .toString("base64url");
        const rawPayload = encode(payload);
        const signingInput = `${rawHeader}.${rawPayload}`;
        return `${signingInput}.${createHmac("sha256", Buffer.from(activeSecret, "base64url"))
          .update(signingInput).digest("base64url")}`;
      })(),
    ]) {
      expect(() => verifySocketTicket(ticket, keys, now)).toThrow("INVALID_SOCKET_TICKET");
    }

    const valid = signSocketTicket({ sub: subject, sessionId }, keys, now).ticket;
    const [validHeader, validPayload, validSignature] = valid.split(".") as [string, string, string];
    const tamperedSignature = `${validSignature[0] === "A" ? "B" : "A"}${validSignature.slice(1)}`;
    expect(() => verifySocketTicket(`${validHeader}.${validPayload}.${tamperedSignature}`, keys, now))
      .toThrow("INVALID_SOCKET_TICKET");
    for (const nonCanonical of [
      `${validHeader}=.${validPayload}.${validSignature}`,
      `${validHeader}.${nonCanonicalTail(validPayload)}.${validSignature}`,
      `${validHeader}.${validPayload}.${nonCanonicalTail(validSignature)}`,
    ]) {
      expect(() => verifySocketTicket(nonCanonical, keys, now)).toThrow("INVALID_SOCKET_TICKET");
    }
    expect(() => verifySocketTicket(valid, keys, new Date(now.getTime() + 300_000)))
      .toThrow("INVALID_SOCKET_TICKET");
  });
});
