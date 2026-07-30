ALTER TABLE "outbox_events" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "outbox_events_dead_letter_idx" ON "outbox_events" USING btree ("dead_lettered_at");