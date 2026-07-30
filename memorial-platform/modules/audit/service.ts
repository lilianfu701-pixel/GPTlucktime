import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs } from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { canGovern } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";

export type AuditQueryError = "AUTH_REQUIRED" | "FORBIDDEN";

export const MAX_AUDIT_PAGE = 100;

export type AuditEntry = {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  correlationId: string;
  createdAt: Date;
};

export type AuditFilter = {
  actorUserId?: string | undefined;
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

/**
 * Reads the audit trail.
 *
 * This module offers no way to write, amend or remove an entry, and that is the
 * point rather than an omission: a record that can be edited by the same system
 * it records is not evidence. Entries are written by the services that perform
 * the action, inside the same transaction, and nothing here can reach back and
 * tidy one away.
 *
 * The old and new values are deliberately not returned. They can contain what a
 * family wrote, and a staff member scanning a trail is looking for who did what
 * and when; reading the content itself belongs to opening the specific case.
 */
export async function queryAuditLog(
  actor: Actor,
  filter: AuditFilter = {},
): Promise<Result<AuditEntry[], AuditQueryError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  if (!canGovern({ actor, action: "restrict_editing" })) {
    return err("FORBIDDEN");
  }

  const conditions: SQL[] = [];

  if (filter.actorUserId) {
    conditions.push(eq(auditLogs.actorUserId, filter.actorUserId));
  }
  if (filter.action) {
    conditions.push(eq(auditLogs.action, filter.action));
  }
  if (filter.resourceType) {
    conditions.push(eq(auditLogs.resourceType, filter.resourceType));
  }
  if (filter.resourceId) {
    conditions.push(eq(auditLogs.resourceId, filter.resourceId));
  }
  if (filter.from) {
    conditions.push(gte(auditLogs.createdAt, filter.from));
  }
  if (filter.to) {
    conditions.push(lte(auditLogs.createdAt, filter.to));
  }

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_AUDIT_PAGE);
  const offset = Math.max(filter.offset ?? 0, 0);

  const rows = await db()
    .select({
      id: auditLogs.id,
      actorUserId: auditLogs.actorUserId,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      reason: auditLogs.reason,
      correlationId: auditLogs.correlationId,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(rows);
}

/**
 * Everything recorded about one resource, oldest first.
 *
 * The order matters: a trail is read to understand how something reached its
 * current state, and that reads forwards.
 */
export async function auditTrailFor(
  actor: Actor,
  input: { resourceType: string; resourceId: string },
): Promise<Result<AuditEntry[], AuditQueryError>> {
  const result = await queryAuditLog(actor, {
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    limit: MAX_AUDIT_PAGE,
  });

  if (!result.ok) {
    return result;
  }

  return ok([...result.value].reverse());
}
