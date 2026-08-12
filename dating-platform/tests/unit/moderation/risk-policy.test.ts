import { describe, expect, it } from "vitest";

import { triageReport } from "@/modules/moderation/risk-policy";

describe("triageReport", () => {
  it("isolates suspected child-safety content immediately", () => {
    expect(triageReport({ reason: "MINOR_SAFETY", confidence: 0.9 })).toEqual({
      priority: "emergency",
      temporaryRestriction: true,
      preserveEvidence: true,
    });
  });
});
