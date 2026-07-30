CREATE TYPE "public"."moderation_mode" AS ENUM('pre_review', 'post_review');--> statement-breakpoint
CREATE TABLE "memorial_ritual_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"ritual_definition_id" uuid NOT NULL,
	"ritual_version_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"display_name_override" text,
	"allow_anonymous" boolean DEFAULT false NOT NULL,
	"allow_message" boolean DEFAULT true NOT NULL,
	"moderation_mode" "moderation_mode" DEFAULT 'pre_review' NOT NULL,
	"family_confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memorial_ritual_settings" ADD CONSTRAINT "memorial_ritual_settings_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_ritual_settings" ADD CONSTRAINT "memorial_ritual_settings_ritual_definition_id_ritual_definitions_id_fk" FOREIGN KEY ("ritual_definition_id") REFERENCES "public"."ritual_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_ritual_settings" ADD CONSTRAINT "memorial_ritual_settings_ritual_version_id_ritual_versions_id_fk" FOREIGN KEY ("ritual_version_id") REFERENCES "public"."ritual_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_ritual_settings" ADD CONSTRAINT "memorial_ritual_settings_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memorial_ritual_settings_definition_key" ON "memorial_ritual_settings" USING btree ("memorial_id","ritual_definition_id");--> statement-breakpoint
CREATE INDEX "memorial_ritual_settings_memorial_idx" ON "memorial_ritual_settings" USING btree ("memorial_id","enabled");