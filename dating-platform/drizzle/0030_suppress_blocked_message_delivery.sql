SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "message_outbox_events" DROP CONSTRAINT "message_outbox_status_check";--> statement-breakpoint
ALTER TABLE "message_outbox_events" ADD COLUMN "suppression_reason" varchar(80);--> statement-breakpoint
ALTER TABLE "message_outbox_events" ADD COLUMN "suppressed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_outbox_events" ADD CONSTRAINT "message_outbox_suppression_check" CHECK (
    ("message_outbox_events"."status" = 'suppressed' AND "message_outbox_events"."suppressed_at" IS NOT NULL AND "message_outbox_events"."suppression_reason" IS NOT NULL)
    OR ("message_outbox_events"."status" <> 'suppressed' AND "message_outbox_events"."suppressed_at" IS NULL AND "message_outbox_events"."suppression_reason" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "message_outbox_events" ADD CONSTRAINT "message_outbox_status_check" CHECK ("message_outbox_events"."status" IN ('pending', 'processing', 'published', 'failed', 'suppressed'));--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
RESET lock_timeout;
