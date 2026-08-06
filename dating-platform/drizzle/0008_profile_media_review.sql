CREATE TABLE "media_review_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_review_jobs_photo_id_unique" UNIQUE("photo_id"),
	CONSTRAINT "media_review_jobs_status_check" CHECK ("media_review_jobs"."status" IN ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "media_review_jobs_attempts_check" CHECK ("media_review_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "profile_photo_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size_bytes" integer NOT NULL,
	"token_hash" text NOT NULL,
	"idempotency_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_photo_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_photo_uploads_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "profile_photo_uploads_user_idempotency_unique" UNIQUE("user_id","idempotency_hash"),
	CONSTRAINT "profile_photo_uploads_mime_check" CHECK ("profile_photo_uploads"."mime_type" IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "profile_photo_uploads_size_check" CHECK ("profile_photo_uploads"."declared_size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "upload_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "actual_mime_type" text;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "actual_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "review_provider" text;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "review_version" text;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "cleanup_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "object_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_review_jobs" ADD CONSTRAINT "media_review_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_review_jobs" ADD CONSTRAINT "media_review_jobs_photo_id_profile_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."profile_photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD CONSTRAINT "profile_photo_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photo_uploads" ADD CONSTRAINT "profile_photo_uploads_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_review_jobs_claim_idx" ON "media_review_jobs" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "profile_photo_uploads_quota_idx" ON "profile_photo_uploads" USING btree ("user_id","expires_at");--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_upload_id_profile_photo_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."profile_photo_uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_upload_id_unique" UNIQUE("upload_id");
