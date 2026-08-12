import { z } from "zod";

import { triageReport, type ReportReason, type ReportTriage } from "./risk-policy";

export const REPORT_REASONS = [
  "HARASSMENT",
  "HATE_OR_ABUSE",
  "IMPERSONATION",
  "MINOR_SAFETY",
  "SCAM_OR_FRAUD",
  "SEXUAL_CONTENT",
  "SPAM",
  "THREATS_OR_VIOLENCE",
  "OTHER_SAFETY",
] as const satisfies readonly ReportReason[];

export type ModerationErrorCode =
  | "INVALID_REPORT"
  | "REPORT_NOT_AVAILABLE"
  | "REPORT_IDEMPOTENCY_CONFLICT"
  | "INVALID_CURSOR"
  | "FORBIDDEN"
  | "INVALID_CASE_TRANSITION"
  | "INVALID_ACTION"
  | "INVALID_APPEAL"
  | "EVIDENCE_NOT_AVAILABLE";

export class ModerationError extends Error {
  constructor(readonly code: ModerationErrorCode) {
    super(code);
  }
}

const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const evidenceReferenceSchema = z.object({
  type: z.enum(["profile", "photo"]),
  id: z.string().uuid(),
}).strict();

const reportInputSchema = z.object({
  clientId: z.string().uuid(),
  targetProfileId: z.string().uuid(),
  reason: z.enum(REPORT_REASONS),
  locale: z.string().min(2).max(35).regex(localePattern),
  explanation: z.string().trim().min(1).max(1000),
  messageId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  evidenceReferences: z.array(evidenceReferenceSchema).max(10).default([]),
}).strict().superRefine((value, context) => {
  if (Boolean(value.messageId) !== Boolean(value.conversationId)) {
    context.addIssue({ code: "custom", message: "message and conversation references must be paired" });
  }
});

export type SubmitReportInput = z.infer<typeof reportInputSchema>;

export function parseReportInput(value: unknown): SubmitReportInput {
  const parsed = reportInputSchema.safeParse(value);
  if (!parsed.success) throw new ModerationError("INVALID_REPORT");
  return parsed.data;
}

export type PublicReport = {
  id: string;
  status: "submitted" | "in_review" | "resolved";
  createdAt: string;
  duplicate: boolean;
};

export interface ReportSubmissionRepository {
  submit(input: {
    reporterUserId: string;
    report: SubmitReportInput;
    triage: ReportTriage;
    confidence: number;
  }): Promise<PublicReport>;
  listOwned(input: {
    reporterUserId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ reports: Array<Omit<PublicReport, "duplicate"> & { reason: ReportReason }>; nextCursor: string | null }>;
}

export interface ReportRiskAssessor {
  assess(input: Pick<SubmitReportInput, "reason" | "targetProfileId" | "messageId">): Promise<number>;
}

export class ReportService {
  constructor(
    private readonly repository: ReportSubmissionRepository,
    private readonly riskAssessor: ReportRiskAssessor,
  ) {}

  async submit(reporterUserId: string, value: unknown) {
    const report = parseReportInput(value);
    const confidence = await this.riskAssessor.assess(report);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("RISK_ASSESSMENT_UNAVAILABLE");
    }
    return this.repository.submit({
      reporterUserId,
      report,
      confidence,
      triage: triageReport({ reason: report.reason, confidence }),
    });
  }

  listOwned(reporterUserId: string, input: { limit: number; cursor?: string }) {
    return this.repository.listOwned({ reporterUserId, ...input });
  }
}

export class RuleBasedReportRiskAssessor implements ReportRiskAssessor {
  async assess(input: Pick<SubmitReportInput, "reason">) {
    return input.reason === "MINOR_SAFETY" ? 0.9 : 0.5;
  }
}
