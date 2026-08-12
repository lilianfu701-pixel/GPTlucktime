CREATE TABLE "moderation_media_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"source_object_key" text NOT NULL,
	"source_object_version" text NOT NULL,
	"source_object_etag" text NOT NULL,
	"object_key" text NOT NULL,
	"object_version" text NOT NULL,
	"object_etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_media_copies_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "moderation_media_copies_report_photo_unique" UNIQUE("report_id","photo_id")
);
--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD COLUMN "evidence_copy_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "object_version" text;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "object_etag" text;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "deletion_status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "deletion_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "deletion_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_photo_id_profile_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."profile_photos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_media_copies_case_idx" ON "moderation_media_copies" USING btree ("case_id","created_at");--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD CONSTRAINT "moderation_media_holds_evidence_copy_id_moderation_media_copies_id_fk" FOREIGN KEY ("evidence_copy_id") REFERENCES "public"."moderation_media_copies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_deletion_status_check" CHECK ("profile_photos"."deletion_status" IN ('idle', 'claimed', 'deleting'));--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_deletion_lease_check" CHECK (
      ("profile_photos"."deletion_status" = 'idle' AND "profile_photos"."deletion_lease_id" IS NULL AND "profile_photos"."deletion_lease_expires_at" IS NULL)
      OR ("profile_photos"."deletion_status" IN ('claimed', 'deleting') AND "profile_photos"."deletion_lease_id" IS NOT NULL
        AND "profile_photos"."deletion_lease_expires_at" IS NOT NULL)
    );