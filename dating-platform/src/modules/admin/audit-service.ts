import { createHmac } from "node:crypto";

const sensitiveKey = /(?:message|evidence|token|secret|password|credential|authorization|cookie|email|phone|address|birth|name|image|body|content|pii|latitude|longitude|location|coordinates|^lat$|^lon$)/iu;
const sensitiveValue = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}-\d{2}-\d{4}\b|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|(?:\+?\d[\s().-]*){7,}\d)/iu;
const sensitiveReason = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}-\d{2}-\d{4}\b|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|raw\s+message|evidence\s+(?:token|body|content)|(?:token|secret|password)\s*[=:])/iu;
const sensitiveGeo = /(?:\b(?:geo|location|coordinates?|lat(?:itude)?|lon(?:gitude)?)\b\s*[=:]|\b-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b)/iu;
const uuidTarget = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?::[0-9a-f-]{36}|:[A-Z]{2}:[A-Z]{3})?$/iu;
const hashTarget = /^[a-f0-9]{64}$/u;
const configurationTarget = /^[a-z0-9][a-z0-9._-]{0,79}:(?:global_flag|free_default)$/u;

export function redactAuditDiff(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditDiff);
  if (typeof value === "string" && sensitiveValue.test(value)) return "[REDACTED]";
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sensitiveKey.test(key) ? "[REDACTED]" : redactAuditDiff(item),
  ]));
}

export function sanitizeAuditReason(value: string) {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 500 || sensitiveReason.test(normalized)
    || sensitiveValue.test(normalized) || sensitiveGeo.test(normalized)) {
    throw new Error("SENSITIVE_AUDIT_REASON");
  }
  return normalized;
}

export type AuditRecord = {
  actorUserId: string;
  permission: string;
  targetType: string;
  targetId: string;
  beforeDiff: unknown;
  afterDiff: unknown;
  reason: string;
  requestId: string;
  ipHash: string;
  createdAt: Date;
};

export function buildAuditRecord(input: {
  actorUserId: string;
  permission: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string;
  requestId: string;
  ipAddress: string;
  ipHmacKey: string;
  createdAt?: Date;
}): AuditRecord {
  if (input.targetId.length > 200 || !(uuidTarget.test(input.targetId)
    || hashTarget.test(input.targetId) || configurationTarget.test(input.targetId))) {
    throw new Error("INVALID_AUDIT_TARGET");
  }
  return {
    actorUserId: input.actorUserId,
    permission: input.permission,
    targetType: input.targetType,
    targetId: input.targetId,
    beforeDiff: redactAuditDiff(input.before),
    afterDiff: redactAuditDiff(input.after),
    reason: sanitizeAuditReason(input.reason),
    requestId: input.requestId,
    ipHash: createHmac("sha256", input.ipHmacKey).update(input.ipAddress).digest("hex"),
    createdAt: input.createdAt ?? new Date(),
  };
}
