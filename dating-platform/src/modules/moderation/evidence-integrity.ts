import { createHash, timingSafeEqual } from "node:crypto";

import type { ControlledEvidenceLocator, ModerationTargetSnapshot } from "@/db/schema";

type EvidenceIntegrityInput = {
  reportId: string;
  caseId: string;
  subjectUserId: string;
  targetSnapshot: ModerationTargetSnapshot;
  locator: ControlledEvidenceLocator;
  capturedAt: Date;
};

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(record[key])}`
  )).join(",")}}`;
};

export const evidenceIntegritySha256 = (input: EvidenceIntegrityInput) => createHash("sha256")
  .update(canonicalize({
    schemaVersion: 1,
    reportId: input.reportId,
    caseId: input.caseId,
    subjectUserId: input.subjectUserId,
    targetSnapshot: input.targetSnapshot,
    locator: input.locator,
    capturedAt: input.capturedAt.toISOString(),
  }))
  .digest("hex");

export const verifyEvidenceIntegrity = (input: EvidenceIntegrityInput, expectedHex: string) => {
  if (!/^[a-f0-9]{64}$/u.test(expectedHex)) return false;
  const calculated = Buffer.from(evidenceIntegritySha256(input), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return calculated.length === expected.length && timingSafeEqual(calculated, expected);
};
