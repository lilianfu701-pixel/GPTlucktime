import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("DB-backed admin sensitive workflow access", () => {
  it("removes caller-asserted verified access and wires both production readers through the resolver", async () => {
    const [permissions, resolver, evidence, message] = await Promise.all([
      readFile("src/modules/admin/permissions.ts", "utf8"),
      readFile("src/modules/admin/admin-sensitive-access.ts", "utf8"),
      readFile("src/app/api/v1/admin/cases/[caseId]/evidence/route.ts", "utf8"),
      readFile("src/app/api/v1/admin/messages/[messageId]/route.ts", "utf8"),
    ]);
    expect(permissions).not.toContain("canAccessPrivateMessages");
    expect(permissions).not.toContain("verified: boolean");
    expect(resolver).toContain("DrizzleAdminSensitiveWorkflowResolver");
    expect(resolver).toContain("adminSafetyAccessGrants");
    expect(resolver).toContain("legalWorkflowTasks");
    expect(resolver).toContain("safetyAlerts");
    expect(evidence).toContain("createAdminEvidenceReadHandler");
    expect(message).toContain("createAdminPrivateMessageReadHandler");
  });
});
