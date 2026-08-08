SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" DROP CONSTRAINT "profile_photo_uploads_user_quota_slot_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "profile_photo_uploads_user_quota_slot_active_idx" ON "profile_photo_uploads" USING btree ("user_id","quota_slot") WHERE "profile_photo_uploads"."quota_slot" IS NOT NULL;--> statement-breakpoint
UPDATE "profiles"
SET "status" = 'draft', "discoverable" = false, "publish_requested" = false, "updated_at" = now()
WHERE "status" = 'active' AND "time_zone" IS NULL;
