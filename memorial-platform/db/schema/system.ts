import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Append-only record of every consequential state change.
 *
 * The application never updates or deletes these rows. Fields are deliberately
 * narrow: an audit entry records what changed, not the content that changed, so
 * private message bodies and dispute evidence stay out of it.
 *
 * See docs/memorial-platform/03-data-model.md section 1 and
 * 06-security-privacy-moderation.md section 8.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Null for platform-initiated actions such as a scheduled retirement. */
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    reason: text("reason"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_logs_resource_idx").on(table.resourceType, table.resourceId),
    index("audit_logs_actor_idx").on(table.actorUserId),
    index("audit_logs_correlation_idx").on(table.correlationId),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);

/**
 * Transactional outbox.
 *
 * A cross-module side effect is committed as a row here in the same transaction
 * as the business change. A worker picks it up afterwards. This is what stops
 * the system from announcing work that was rolled back, or rolling back work
 * that was already announced.
 *
 * See docs/memorial-platform/02-system-architecture.md section 6.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    topic: text("topic").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    /** Moves forward on each retry to implement exponential backoff. */
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /**
     * Set when an event has stopped being retried.
     *
     * A dead letter is kept, never deleted. An event that could not be
     * delivered is the record of a side effect that did not happen — a family
     * who was not notified, a photograph that was not scanned — and the row is
     * the only place that is visible.
     */
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    /**
     * Why the last attempt failed, as a short reason code or truncated message.
     *
     * Bounded on write. An unbounded error string is how a connection string or
     * a token ends up in a table that operators read casually.
     */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The worker's claim query: unprocessed events that are due, oldest first.
    index("outbox_events_due_idx").on(table.processedAt, table.availableAt),
    // Operators ask "what is stuck?" far more often than anything else.
    index("outbox_events_dead_letter_idx").on(table.deadLetteredAt),
    index("outbox_events_topic_idx").on(table.topic),
    index("outbox_events_aggregate_idx").on(table.aggregateId),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
