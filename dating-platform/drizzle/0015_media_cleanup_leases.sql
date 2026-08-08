SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "artifact_cleanup_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD COLUMN "artifact_cleanup_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "profile_photo_uploads_artifact_cleanup_lease_idx" ON "profile_photo_uploads" USING btree ("artifact_cleanup_lease_expires_at");
