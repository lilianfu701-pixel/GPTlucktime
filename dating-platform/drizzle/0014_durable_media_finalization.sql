SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "final_object_key" text;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "source_etag" text;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "finalization_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "finalization_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "finalization_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "staging_cleanup_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "staging_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "final_orphan_cleanup_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "final_orphan_deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "profile_photo_uploads_finalize_claim_idx" ON "profile_photo_uploads" USING btree ("finalization_status","finalization_lease_expires_at");--> statement-breakpoint
CREATE INDEX "profile_photo_uploads_artifact_cleanup_idx" ON "profile_photo_uploads" USING btree ("staging_cleanup_due_at","final_orphan_cleanup_due_at");--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD CONSTRAINT "profile_photo_uploads_finalization_status_check" CHECK ("profile_photo_uploads"."finalization_status" IN ('pending', 'processing', 'finalized', 'cleanup'));
