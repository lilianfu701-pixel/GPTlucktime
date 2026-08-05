ALTER TABLE "verification_attempts" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD COLUMN "redirect_url_encrypted" text;--> statement-breakpoint
-- Preserve the newest pending identity attempt per user. Older duplicate rows remain
-- queryable as expired audit records before the partial unique index is installed.
WITH ranked_pending_identity AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "user_id", "kind"
		ORDER BY "created_at" DESC, "id" DESC
	) AS rank
	FROM "verification_attempts"
	WHERE "user_id" IS NOT NULL AND "kind" = 'identity' AND "status" = 'pending'
)
UPDATE "verification_attempts" AS attempts
SET "status" = 'expired', "updated_at" = now()
FROM ranked_pending_identity AS ranked
WHERE attempts."id" = ranked."id" AND ranked.rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_attempts_pending_user_kind_unique" ON "verification_attempts" USING btree ("user_id","kind") WHERE "verification_attempts"."kind" = 'identity' AND "verification_attempts"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "verification_attempts_idempotency_unique" ON "verification_attempts" USING btree ("user_id","kind","idempotency_key_hash") WHERE "verification_attempts"."idempotency_key_hash" is not null;--> statement-breakpoint
CREATE INDEX "verification_webhook_events_received_at_idx" ON "verification_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "verification_webhook_events_attempt_idx" ON "verification_webhook_events" USING btree ("attempt_id");
