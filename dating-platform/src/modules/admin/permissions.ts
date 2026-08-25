export const ADMIN_ROLES = [
  "support", "moderation", "safety", "operations", "finance", "super_admin",
] as const;

export type AdminRole = typeof ADMIN_ROLES[number];

export const ADMIN_PERMISSIONS = [
  "admin.console.read",
  "profile_media.read",
  "profile_media.decide",
  "reports.read",
  "reports.decide",
  "appeals.read",
  "appeals.decide",
  "billing.discrepancies.read",
  "billing.refund.request",
  "billing.refund.approve",
  "billing.config.write",
  "billing.config.approve",
  "verification.failures.read",
  "configuration.changes.read",
  "entitlements.config.write",
  "users.status.write",
  "users.bulk_suspend.request",
  "users.bulk_suspend.approve",
  "exports.sensitive.request",
  "exports.sensitive.approve",
  "messages.private.read",
  "safety.evidence.request",
  "safety.evidence.approve",
] as const;

export type AdminPermission = typeof ADMIN_PERMISSIONS[number];

export const ADMIN_ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly AdminPermission[]>> = {
  support: ["admin.console.read", "profile_media.read", "verification.failures.read"],
  moderation: ["admin.console.read", "profile_media.read", "profile_media.decide", "reports.read", "reports.decide", "appeals.read", "appeals.decide"],
  safety: [
    "admin.console.read", "profile_media.read", "profile_media.decide", "reports.read", "reports.decide", "appeals.read",
    "appeals.decide", "messages.private.read", "safety.evidence.request", "safety.evidence.approve",
    "users.status.write", "users.bulk_suspend.request", "users.bulk_suspend.approve",
    "exports.sensitive.request", "exports.sensitive.approve",
  ],
  operations: [
    "admin.console.read", "profile_media.read", "verification.failures.read", "configuration.changes.read",
    "users.status.write", "users.bulk_suspend.request", "users.bulk_suspend.approve", "entitlements.config.write",
  ],
  finance: [
    "admin.console.read", "billing.discrepancies.read", "billing.refund.request", "billing.refund.approve",
    "billing.config.write", "billing.config.approve", "configuration.changes.read",
  ],
  super_admin: [...ADMIN_PERMISSIONS],
};

const normalizeRole = (value: string): AdminRole | null => {
  const normalized = value === "moderator" ? "moderation" : value;
  return (ADMIN_ROLES as readonly string[]).includes(normalized) ? normalized as AdminRole : null;
};

export function hasPermission(role: string, permission: string): permission is AdminPermission {
  const trustedRole = normalizeRole(role);
  return Boolean(trustedRole
    && (ADMIN_PERMISSIONS as readonly string[]).includes(permission)
    && ADMIN_ROLE_PERMISSIONS[trustedRole].includes(permission as AdminPermission));
}

export function requirePermission(role: string, permission: AdminPermission) {
  if (!hasPermission(role, permission)) throw new Error("FORBIDDEN");
}

export const RECENT_MFA_WINDOW_MS = 5 * 60_000;

export function requireRecentMfa(session: { mfaVerifiedAt: Date | null }, now = new Date()) {
  const verifiedAt = session.mfaVerifiedAt;
  if (!verifiedAt || Number.isNaN(verifiedAt.getTime())
    || verifiedAt.getTime() > now.getTime()
    || now.getTime() - verifiedAt.getTime() > RECENT_MFA_WINDOW_MS) {
    throw new Error("RECENT_MFA_REQUIRED");
  }
}
