CREATE TYPE "public"."media_kind" AS ENUM('image', 'video', 'audio');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('pending_upload', 'scanning', 'processing', 'ready', 'rejected', 'deleted');--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid,
	"kind" "media_kind" NOT NULL,
	"declared_content_type" text NOT NULL,
	"detected_content_type" text,
	"declared_bytes" bigint NOT NULL,
	"actual_bytes" bigint,
	"display_file_name" text NOT NULL,
	"status" "media_status" DEFAULT 'pending_upload' NOT NULL,
	"rejection_reason" text,
	"quarantine_object_key" text NOT NULL,
	"ready_object_key" text,
	"alt_text" text,
	"caption_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_memorial_idx" ON "media_assets" USING btree ("memorial_id","status");--> statement-breakpoint
CREATE INDEX "media_assets_status_idx" ON "media_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "media_variants_asset_idx" ON "media_variants" USING btree ("asset_id");