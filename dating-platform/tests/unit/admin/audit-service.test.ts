import { describe, expect, it } from "vitest";

import { buildAuditRecord, redactAuditDiff, sanitizeAuditReason } from "@/modules/admin/audit-service";

describe("admin audit service", () => {
  it("recursively redacts messages, evidence, tokens, secrets and PII", () => {
    const redacted = redactAuditDiff({
      status: "active",
      nested: { message: "private", evidence: { body: "raw" }, accessToken: "secret" },
      email: "person@example.com",
      phoneNumber: "+12065550100",
    });
    expect(redacted).toEqual({
      status: "active",
      nested: { message: "[REDACTED]", evidence: "[REDACTED]", accessToken: "[REDACTED]" },
      email: "[REDACTED]",
      phoneNumber: "[REDACTED]",
    });
    expect(JSON.stringify(redacted)).not.toContain("private");
    expect(JSON.stringify(redacted)).not.toContain("person@example.com");
  });

  it("recursively redacts sensitive keys and recognizable secret/PII values", () => {
    const value = redactAuditDiff({
      safe: "unchanged",
      nested: [{ note: "contact reviewer@example.com or +1 (415) 555-2671" }],
      identifier: "123-45-6789",
      credential: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      coordinates: { lat: 37.7749, lon: -122.4194 },
      rawMessage: "review reproduction string",
      evidence: { excerpt: "must never appear" },
    });
    const serialized = JSON.stringify(value);
    expect(serialized).toContain("unchanged");
    for (const leaked of ["reviewer@example.com", "415", "123-45-6789", "eyJhbGci", "37.7749",
      "review reproduction string", "must never appear"]) expect(serialized).not.toContain(leaked);
  });

  it("rejects audit reasons containing PII, bearer credentials, or raw message/evidence labels", () => {
    for (const reason of ["contact reviewer@example.com", "Bearer abc.def.ghi", "raw message: reproduce this",
      "evidence token=secret-value", "call +1 (415) 555-2671", "location=37.7749,-122.4194",
      "lat: 37.7749 lon: -122.4194"]) {
      expect(() => sanitizeAuditReason(reason)).toThrow("SENSITIVE_AUDIT_REASON");
    }
    expect(sanitizeAuditReason("independently verified policy violation")).toBe("independently verified policy violation");
  });

  it("builds the complete append-only audit envelope and hashes the IP", () => {
    const record = buildAuditRecord({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      permission: "users.status.write",
      targetType: "user",
      targetId: "00000000-0000-4000-8000-000000000002",
      before: { status: "active", token: "raw" },
      after: { status: "suspended", token: "new" },
      reason: "confirmed policy violation",
      requestId: "00000000-0000-4000-8000-000000000003",
      ipAddress: "203.0.113.7",
      ipHmacKey: "test-only-hmac-key",
      createdAt: new Date("2026-08-14T12:00:00.000Z"),
    });
    expect(record).toMatchObject({
      permission: "users.status.write", targetType: "user",
      reason: "confirmed policy violation", requestId: "00000000-0000-4000-8000-000000000003",
      beforeDiff: { status: "active", token: "[REDACTED]" },
      afterDiff: { status: "suspended", token: "[REDACTED]" },
    });
    expect(record.ipHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(record)).not.toContain("203.0.113.7");
  });

  it("rejects PII-bearing or caller-shaped audit target identifiers", () => {
    expect(() => buildAuditRecord({ actorUserId: "00000000-0000-4000-8000-000000000001",
      permission: "billing.refund.approve", targetType: "payment", targetId: "reviewer@example.com",
      before: {}, after: {}, reason: "bounded payment review",
      requestId: "00000000-0000-4000-8000-000000000002", ipAddress: "203.0.113.8",
      ipHmacKey: "h".repeat(32), createdAt: new Date("2026-08-14T12:00:00.000Z") }))
      .toThrow("INVALID_AUDIT_TARGET");
  });
});
