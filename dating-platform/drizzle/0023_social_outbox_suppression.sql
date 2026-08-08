SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "social_outbox_events" DROP CONSTRAINT "social_outbox_status_check";--> statement-breakpoint
ALTER TABLE "social_outbox_events" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_outbox_events" ADD COLUMN "suppressed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_outbox_events" ADD COLUMN "suppression_reason" text;--> statement-breakpoint
UPDATE "social_outbox_events"
SET "published_at" = "created_at"
WHERE "status" = 'published';--> statement-breakpoint
UPDATE "social_outbox_events"
SET "status" = 'pending', "lease_id" = NULL, "lease_expires_at" = NULL
WHERE "status" = 'processing'
  AND ("lease_id" IS NULL OR "lease_expires_at" IS NULL);--> statement-breakpoint
UPDATE "social_outbox_events"
SET "lease_id" = NULL, "lease_expires_at" = NULL
WHERE "status" <> 'processing';--> statement-breakpoint
ALTER TABLE "social_outbox_events" ADD CONSTRAINT "social_outbox_lease_consistency_check" CHECK (
    ("social_outbox_events"."status" = 'processing' AND "social_outbox_events"."lease_id" IS NOT NULL AND "social_outbox_events"."lease_expires_at" IS NOT NULL)
    OR ("social_outbox_events"."status" <> 'processing' AND "social_outbox_events"."lease_id" IS NULL AND "social_outbox_events"."lease_expires_at" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "social_outbox_events" ADD CONSTRAINT "social_outbox_publish_consistency_check" CHECK (
    ("social_outbox_events"."status" = 'published' AND "social_outbox_events"."published_at" IS NOT NULL)
    OR ("social_outbox_events"."status" <> 'published' AND "social_outbox_events"."published_at" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "social_outbox_events" ADD CONSTRAINT "social_outbox_suppression_consistency_check" CHECK (
    ("social_outbox_events"."status" = 'suppressed' AND "social_outbox_events"."suppressed_at" IS NOT NULL AND "social_outbox_events"."suppression_reason" IS NOT NULL)
    OR ("social_outbox_events"."status" <> 'suppressed' AND "social_outbox_events"."suppressed_at" IS NULL AND "social_outbox_events"."suppression_reason" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "social_outbox_events" ADD CONSTRAINT "social_outbox_status_check" CHECK ("social_outbox_events"."status" IN ('pending', 'processing', 'published', 'failed', 'suppressed'));
