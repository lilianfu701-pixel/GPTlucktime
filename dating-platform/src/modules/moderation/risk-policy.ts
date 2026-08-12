export type ReportReason =
  | "HARASSMENT"
  | "HATE_OR_ABUSE"
  | "IMPERSONATION"
  | "MINOR_SAFETY"
  | "SCAM_OR_FRAUD"
  | "SEXUAL_CONTENT"
  | "SPAM"
  | "THREATS_OR_VIOLENCE"
  | "OTHER_SAFETY";

export type ReportTriage = {
  priority: "emergency" | "high" | "normal";
  temporaryRestriction: boolean;
  preserveEvidence: boolean;
};

export function triageReport(input: { reason: ReportReason; confidence: number }): ReportTriage {
  if (input.reason === "MINOR_SAFETY" && input.confidence >= 0.9) {
    return {
      priority: "emergency",
      temporaryRestriction: true,
      preserveEvidence: true,
    };
  }
  return {
    priority: input.confidence >= 0.75 ? "high" : "normal",
    temporaryRestriction: false,
    preserveEvidence: false,
  };
}
