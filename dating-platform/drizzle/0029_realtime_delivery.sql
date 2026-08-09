SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "message_outbox_events" ADD COLUMN "last_error_code" varchar(80);--> statement-breakpoint
ALTER TABLE "message_outbox_events" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_outbox_events" ADD CONSTRAINT "message_outbox_failure_check" CHECK (
    ("message_outbox_events"."status" = 'failed' AND "message_outbox_events"."failed_at" IS NOT NULL AND "message_outbox_events"."last_error_code" IS NOT NULL)
    OR ("message_outbox_events"."status" <> 'failed' AND "message_outbox_events"."failed_at" IS NULL)
  );--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
RESET lock_timeout;
