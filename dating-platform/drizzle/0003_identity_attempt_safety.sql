ALTER TABLE "verification_attempts" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD COLUMN "redirect_url_encrypted" text;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_attempts_pending_user_kind_unique" ON "verification_attempts" USING btree ("user_id","kind") WHERE "verification_attempts"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "verification_attempts_idempotency_unique" ON "verification_attempts" USING btree ("user_id","kind","idempotency_key_hash") WHERE "verification_attempts"."idempotency_key_hash" is not null;--> statement-breakpoint
CREATE INDEX "verification_webhook_events_received_at_idx" ON "verification_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "verification_webhook_events_attempt_idx" ON "verification_webhook_events" USING btree ("attempt_id");