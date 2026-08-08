import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { DiscoveryFilters } from "./discovery-types";

export const RANKING_VERSION = "discovery-v1";

export type RankingInput = {
  eligible: boolean;
  compatibilityScore: number;
  activityScore: number;
  verificationScore: number;
  boost: number;
};

export function rankCandidate(input: RankingInput) {
  if (!input.eligible) return null;
  if (![input.compatibilityScore, input.activityScore, input.verificationScore, input.boost]
    .every(Number.isFinite)) return null;
  const paidBoost = Math.min(Math.max(input.boost, 0), 1.5) * 10;
  return input.compatibilityScore + input.activityScore + input.verificationScore + paidBoost;
}

const cursorPayloadSchema = z.object({
  rankingVersion: z.string().min(1).max(50),
  filterFingerprint: z.string().length(43),
  snapshotId: z.string().uuid(),
  nextOrdinal: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
}).strict();

export type DiscoveryCursorPayload = z.infer<typeof cursorPayloadSchema>;

const canonicalFilters = (filters: Partial<DiscoveryFilters>) => Object.fromEntries(
  Object.entries(filters)
    .filter(([key, value]) => key !== "cursor" && key !== "pageSize" && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
);

export const filterFingerprint = (filters: Partial<DiscoveryFilters>) =>
  createHash("sha256").update(JSON.stringify(canonicalFilters(filters))).digest("base64url");

const signCursor = (encoded: string, secret: string) =>
  createHmac("sha256", secret).update("discovery-cursor\u0000").update(encoded).digest("base64url");

export function encodeDiscoveryCursor(payload: DiscoveryCursorPayload, secret: string) {
  if (secret.length < 32) throw new Error("CURSOR_SECRET_UNAVAILABLE");
  const validated = cursorPayloadSchema.parse(payload);
  const encoded = Buffer.from(JSON.stringify(validated)).toString("base64url");
  return `${encoded}.${signCursor(encoded, secret)}`;
}

export function decodeDiscoveryCursor(
  cursor: string,
  secret: string,
  expected: Pick<DiscoveryCursorPayload, "rankingVersion" | "filterFingerprint">,
) {
  try {
    if (secret.length < 32 || cursor.length > 2_000) throw new Error();
    const [encoded, suppliedSignature, extra] = cursor.split(".");
    if (!encoded || !suppliedSignature || extra) throw new Error();
    const expectedSignature = signCursor(encoded, secret);
    const supplied = Buffer.from(suppliedSignature);
    const expectedBytes = Buffer.from(expectedSignature);
    if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) throw new Error();
    const payload = cursorPayloadSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (payload.rankingVersion !== expected.rankingVersion
      || payload.filterFingerprint !== expected.filterFingerprint) throw new Error();
    return payload;
  } catch {
    throw new Error("INVALID_CURSOR");
  }
}
