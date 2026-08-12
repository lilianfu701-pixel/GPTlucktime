import { describe, expect, it } from "vitest";

import { ModerationError, parseReportInput } from "@/modules/moderation/report-service";

const profileReport = {
  clientId: "00000000-0000-4000-8000-000000000101",
  targetProfileId: "00000000-0000-4000-8000-000000000201",
  reason: "HARASSMENT",
  locale: "zh-CN",
  explanation: "  repeated unwanted contact  ",
  evidenceReferences: [{ type: "profile", id: "00000000-0000-4000-8000-000000000201" }],
};

describe("parseReportInput", () => {
  it("normalizes a fixed-code localized report with controlled references", () => {
    expect(parseReportInput(profileReport)).toEqual({
      ...profileReport,
      explanation: "repeated unwanted contact",
    });
  });

  it.each([
    { ...profileReport, reason: "CUSTOM_REASON" },
    { ...profileReport, locale: "x" },
    { ...profileReport, explanation: "x".repeat(1001) },
    { ...profileReport, evidenceReferences: [{ type: "url", id: "https://evil.example/evidence" }] },
    { ...profileReport, evidenceReferences: [{ type: "profile", id: "<script>secret</script>" }] },
    { ...profileReport, threshold: 0.9 },
  ])("rejects non-whitelisted, oversized or internal-rule input", (input) => {
    expect(() => parseReportInput(input)).toThrow(ModerationError);
  });

  it("requires message and conversation references together", () => {
    expect(() => parseReportInput({
      ...profileReport,
      messageId: "00000000-0000-4000-8000-000000000301",
    })).toThrow("INVALID_REPORT");
  });
});
