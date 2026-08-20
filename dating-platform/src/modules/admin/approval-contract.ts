import { createHash } from "node:crypto";

import { z } from "zod";

import { sanitizeAuditReason } from "./audit-service";

const uuid = z.string().uuid();
const reason = z.string().trim().min(1).max(500).superRefine((value, context) => {
  try { sanitizeAuditReason(value); } catch { context.addIssue({ code: "custom", message: "sensitive reason" }); }
});
const base = { payloadVersion: z.number().int().min(1).max(1_000_000), reason };
const safeReasonCode = z.string().trim().min(1).max(80).superRefine((value, context) => {
  try { sanitizeAuditReason(value); } catch { context.addIssue({ code: "custom", message: "sensitive reason code" }); }
});

export const bulkApprovalPayloadSchema = z.object({
  targets: z.array(z.object({ userId: uuid, caseId: uuid, expectedVersion: z.number().int().min(0),
    durationHours: z.number().int().min(1).max(8760) }).strict()).min(1).max(100),
  reasonCode: safeReasonCode,
}).strict().superRefine((payload, context) => {
  const users = new Set<string>();
  for (const [index, target] of payload.targets.entries()) {
    if (users.has(target.userId)) context.addIssue({ code: "custom", path: ["targets", index, "userId"],
      message: "duplicate target" });
    users.add(target.userId);
  }
});

export const exportApprovalPayloadSchema = z.discriminatedUnion("exportKind", [
  z.object({ exportKind: z.literal("case_activity"), scope: z.object({ caseId: uuid }).strict() }).strict(),
  z.object({ exportKind: z.literal("billing_ledger"), scope: z.object({ subjectUserId: uuid }).strict() }).strict(),
  z.object({ exportKind: z.literal("safety_case"), scope: z.object({ caseId: uuid }).strict() }).strict(),
]);

export const refundApprovalPayloadSchema = z.object({ paymentId: uuid,
  amount: z.number().int().min(1).max(1_000_000_000) }).strict();

export const priceApprovalPayloadSchema = z.object({ planId: uuid, expectedVersion: z.number().int().min(0),
  countryCode: z.string().regex(/^[A-Z]{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u),
  unitAmount: z.number().int().min(0).max(1_000_000_000), interval: z.enum(["monthly", "quarterly", "yearly"]),
  intervalCount: z.number().int().min(1).max(36), taxMode: z.enum(["inclusive", "exclusive"]),
  providerPriceId: z.string().trim().min(3).max(255), effectiveAt: z.string().datetime(),
}).strict();

export const safetyApprovalPayloadSchema = z.object({ actorUserId: uuid, caseId: uuid, reportId: uuid,
  evidenceId: uuid.optional(), messageId: uuid.optional(), expiresAt: z.string().datetime(),
}).strict().refine((row) => Boolean(row.evidenceId) !== Boolean(row.messageId));

export const approvalRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("bulk_suspension"), payload: bulkApprovalPayloadSchema }).strict(),
  z.object({ ...base, action: z.literal("sensitive_export"), payload: exportApprovalPayloadSchema }).strict(),
  z.object({ ...base, action: z.literal("manual_refund"), payload: refundApprovalPayloadSchema }).strict(),
  z.object({ ...base, action: z.literal("payment_configuration"), payload: priceApprovalPayloadSchema }).strict(),
  z.object({ ...base, action: z.literal("safety_evidence_access"), payload: safetyApprovalPayloadSchema }).strict(),
]);

export type ApprovalRequestInput = z.infer<typeof approvalRequestSchema>;

export const canonicalAdminJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalAdminJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalAdminJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

const sha256 = (value: unknown) => createHash("sha256").update(canonicalAdminJson(value)).digest("hex");

export function normalizeAndDeriveApproval(input: ApprovalRequestInput) {
  if (input.action === "bulk_suspension") {
    const payload = { ...input.payload, targets: [...input.payload.targets]
      .sort((left, right) => left.userId.localeCompare(right.userId)) };
    return { ...input, payload, targetType: "user_batch", targetId: sha256(payload.targets) } as const;
  }
  if (input.action === "sensitive_export") return { ...input, targetType: "export_scope",
    targetId: sha256({ exportKind: input.payload.exportKind, scope: input.payload.scope }) } as const;
  if (input.action === "manual_refund") return { ...input, targetType: "payment",
    targetId: input.payload.paymentId } as const;
  if (input.action === "payment_configuration") return { ...input, targetType: "billing_price",
    targetId: `${input.payload.planId}:${input.payload.countryCode}:${input.payload.currency}` } as const;
  const resourceId = input.payload.evidenceId ?? input.payload.messageId!;
  return { ...input, targetType: "safety_case", targetId: `${input.payload.caseId}:${resourceId}` } as const;
}

export function approvalSafePreview(action: ApprovalRequestInput["action"], payload: unknown,
  extra: { currency?: unknown } = {}) {
  if (action === "bulk_suspension") {
    const parsed = bulkApprovalPayloadSchema.parse(payload);
    return { action: "suspend", reasonCode: parsed.reasonCode,
      items: parsed.targets.map(({ userId, caseId, expectedVersion, durationHours }) =>
      ({ userId, caseId, expectedVersion, durationHours })) };
  }
  if (action === "sensitive_export") {
    const parsed = exportApprovalPayloadSchema.parse(payload);
    return { exportKind: parsed.exportKind, scope: parsed.scope };
  }
  if (action === "manual_refund") {
    const parsed = refundApprovalPayloadSchema.parse(payload);
    return { paymentId: parsed.paymentId, amount: parsed.amount,
      currency: typeof extra.currency === "string" ? extra.currency : null };
  }
  if (action === "payment_configuration") {
    const parsed = priceApprovalPayloadSchema.parse(payload);
    return parsed;
  }
  const parsed = safetyApprovalPayloadSchema.parse(payload);
  return { caseId: parsed.caseId, reportId: parsed.reportId,
    ...(parsed.evidenceId ? { evidenceId: parsed.evidenceId } : { messageId: parsed.messageId }),
    expiresAt: parsed.expiresAt };
}
