import { describe, expect, it } from "vitest";

import {
  ADMIN_ROLE_PERMISSIONS,
  hasPermission,
  requireRecentMfa,
} from "@/modules/admin/permissions";

describe("admin RBAC", () => {
  it("defines every role explicitly and defaults unknown roles and permissions to deny", () => {
    expect(Object.keys(ADMIN_ROLE_PERMISSIONS).sort()).toEqual([
      "finance", "moderation", "operations", "safety", "super_admin", "support",
    ]);
    expect(hasPermission("moderation", "reports.decide")).toBe(true);
    expect(hasPermission("moderation", "billing.config.write")).toBe(false);
    expect(hasPermission("finance", "messages.private.read")).toBe(false);
    expect(hasPermission("unknown", "reports.read")).toBe(false);
    expect(hasPermission("super_admin", "unknown.permission")).toBe(false);
  });

  it("uses a bounded server timestamp for recent MFA", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(() => requireRecentMfa({ mfaVerifiedAt: new Date(now.getTime() - 4 * 60_000) }, now)).not.toThrow();
    expect(() => requireRecentMfa({ mfaVerifiedAt: new Date(now.getTime() - 6 * 60_000) }, now)).toThrow("RECENT_MFA_REQUIRED");
    expect(() => requireRecentMfa({ mfaVerifiedAt: null }, now)).toThrow("RECENT_MFA_REQUIRED");
  });
});
