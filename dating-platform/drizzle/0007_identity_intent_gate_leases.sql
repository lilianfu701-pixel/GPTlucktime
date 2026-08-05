ALTER TABLE "identity_session_intents" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "identity_session_intents" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
-- A pre-lease processing row may have been abandoned by an old worker. Requeue it so the
-- delivery-key idempotency contract can recover it under the new lease protocol.
UPDATE "auth_notification_deliveries"
SET "status" = 'pending',
    "available_at" = now(),
    "lease_id" = NULL,
    "lease_expires_at" = NULL,
    "last_error" = 'NOTIFICATION_LEGACY_PROCESSING_RECOVERED',
    "updated_at" = now()
WHERE "status" = 'processing' AND "lease_id" IS NULL;--> statement-breakpoint
-- Keep the earliest initiating intent as the authoritative gate. Later legacy duplicates
-- remain recoverable: the reconciliation worker recreates each idempotent provider session
-- and compensates it before marking the intent terminal.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "user_id", "kind"
           ORDER BY "created_at" ASC, "id" ASC
         ) AS duplicate_rank
  FROM "identity_session_intents"
  WHERE "status" = 'initiating'
)
UPDATE "identity_session_intents" AS intent
SET "status" = 'compensation_pending',
    "available_at" = now(),
    "last_error" = 'IDENTITY_INTENT_SUPERSEDED',
    "updated_at" = now()
FROM ranked
WHERE intent."id" = ranked."id" AND ranked.duplicate_rank > 1;--> statement-breakpoint
CREATE INDEX "identity_session_intents_claim_idx" ON "identity_session_intents" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_session_intents_initiating_user_kind_unique" ON "identity_session_intents" USING btree ("user_id","kind") WHERE "identity_session_intents"."status" = 'initiating';
