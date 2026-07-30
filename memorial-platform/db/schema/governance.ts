import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { memorials, relationshipKind } from "./memorial";

/**
 * Someone a family has asked not to hear from again.
 *
 * Scoped to one memorial. A person who behaved badly on one page has not
 * necessarily done anything to another family, and a platform-wide ban is a
 * separate, audited governance action.
 *
 * The row is kept after being lifted, so a later dispute can show what was done
 * and when.
 */
export const blockedUsers = pgTable(
  "blocked_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    blockedUserId: uuid("blocked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedByUserId: uuid("blocked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Kept for the family's record. Never shown to the person blocked. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("blocked_users_memorial_user_key").on(
      table.memorialId,
      table.blockedUserId,
    ),
    index("blocked_users_memorial_idx").on(table.memorialId),
  ],
);

/** The categories a reporter can choose. Doc 06 section 6. */
export const reportCategory = pgEnum("report_category", [
  "identity_impersonation",
  "false_death",
  "privacy_violation",
  "harassment_or_hate",
  "violent_or_explicit",
  "spam",
  "copyright",
  "religious_or_cultural_error",
  "ownership_dispute",
  "other_safety",
]);

export const caseStatus = pgEnum("case_status", [
  "open",
  "triaged",
  "investigating",
  "resolved",
  "dismissed",
  "appealed",
]);

export const moderationActionKind = pgEnum("moderation_action_kind", [
  "restrict_editing",
  "restrict_interactions",
  "temporarily_hide",
  "restore",
  "block_user",
  "merge_duplicate",
  "transfer_ownership",
  "freeze_ownership",
  "resolve_dispute",
  /**
   * Kept apart from reading it. Conflating the two would make the trail lie:
   * an auditor could not tell a claimant uploading their own certificate from
   * a staff member opening someone else's.
   */
  "attach_dispute_evidence",
  "access_dispute_evidence",
]);

/**
 * A complaint, as received.
 *
 * `contactEmail` is stored so a reporter who is not signed in can be told the
 * outcome. It lives here rather than in any log, because doc 06 section 8
 * forbids addresses in operational records but a case has to be answerable.
 */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    category: reportCategory("category").notNull(),
    description: text("description"),
    reporterUserId: uuid("reporter_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    contactEmail: text("contact_email"),
    status: caseStatus("status").default("open").notNull(),
    caseId: uuid("case_id"),
    requestIpHash: text("request_ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("reports_resource_idx").on(table.resourceType, table.resourceId),
    index("reports_status_idx").on(table.status, table.createdAt),
  ],
);

/**
 * The work item a reviewer acts on.
 *
 * Separate from the report because several complaints can describe one problem,
 * and because a case can also be opened without any complaint at all.
 */
export const moderationCases = pgTable(
  "moderation_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id").references(() => memorials.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    status: caseStatus("status").default("open").notNull(),
    assignedReviewerId: uuid("assigned_reviewer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolution: text("resolution"),
    /** One review is allowed. Doc 06 section 7. */
    appealCount: integer("appeal_count").default(0).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [index("moderation_cases_status_idx").on(table.status)],
);

/**
 * Everything a reviewer did, with the reason.
 *
 * Append-only. Doc 06 section 6 requires the reason, the actor, the resource,
 * the old and new state and the correlation id for every action, because the
 * question a dispute later asks is not what the state is but how it got there.
 */
export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id").references(() => moderationCases.id, {
      onDelete: "cascade",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: moderationActionKind("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    reason: text("reason").notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("moderation_actions_case_idx").on(table.caseId),
    index("moderation_actions_resource_idx").on(
      table.resourceType,
      table.resourceId,
    ),
  ],
);

/**
 * Someone claiming they should manage a memorial.
 *
 * The platform records the claim and freezes what needs freezing. It does not
 * rank a spouse above a child, or a parent above a sibling: doc 06 section 7
 * leaves that to the policy in doc 11 section 3, and encoding a guess would be
 * making that decision for every family on the platform.
 */
export const ownershipDisputes = pgTable(
  "ownership_disputes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    claimantUserId: uuid("claimant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    claimedRelationship: relationshipKind("claimed_relationship").notNull(),
    statement: text("statement").notNull(),
    caseId: uuid("case_id").references(() => moderationCases.id, {
      onDelete: "set null",
    }),
    status: caseStatus("status").default("open").notNull(),
    outcome: text("outcome"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    appealedAt: timestamp("appealed_at", { withTimezone: true }),
    appealCount: integer("appeal_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("ownership_disputes_open_claim_key").on(
      table.memorialId,
      table.claimantUserId,
    ),
    index("ownership_disputes_memorial_idx").on(table.memorialId),
  ],
);

/**
 * A document supporting a claim: a death certificate, a marriage record.
 *
 * Held completely apart from memorial media. The object key uses a private
 * prefix, no memorial query returns these rows, and nothing here ever reaches a
 * search index. Doc 06 section 7 requires the isolation; doc 06 section 5
 * requires that reading one is itself audited, which `accessCount` and the
 * `access_dispute_evidence` action together record.
 */
export const disputeEvidence = pgTable(
  "dispute_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    disputeId: uuid("dispute_id")
      .notNull()
      .references(() => ownershipDisputes.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    accessCount: integer("access_count").default(0).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    /** Deleted on the policy schedule in doc 11 section 2, not kept forever. */
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("dispute_evidence_dispute_idx").on(table.disputeId)],
);

/**
 * Where a merged memorial's address now points.
 *
 * Kept so that a link a family sent to relatives years ago still works after a
 * merge. Doc 03 section 7 requires the old slug to redirect rather than break.
 */
export const memorialSlugRedirects = pgTable(
  "memorial_slug_redirects",
  {
    slug: text("slug").primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("memorial_slug_redirects_memorial_idx").on(table.memorialId)],
);

export type BlockedUser = typeof blockedUsers.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type ModerationCase = typeof moderationCases.$inferSelect;
export type ModerationAction = typeof moderationActions.$inferSelect;
export type OwnershipDispute = typeof ownershipDisputes.$inferSelect;
export type DisputeEvidence = typeof disputeEvidence.$inferSelect;
