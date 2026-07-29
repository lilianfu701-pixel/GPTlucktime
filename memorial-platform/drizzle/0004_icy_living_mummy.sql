CREATE TYPE "public"."content_status" AS ENUM('draft', 'pending_review', 'published', 'rejected', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('biography', 'timeline_event', 'tribute');--> statement-breakpoint
CREATE TYPE "public"."submission_kind" AS ENUM('story', 'photo');--> statement-breakpoint
CREATE TYPE "public"."translation_method" AS ENUM('human', 'machine');--> statement-breakpoint
CREATE TYPE "public"."translation_status" AS ENUM('draft', 'in_review', 'published', 'retired');--> statement-breakpoint
CREATE TABLE "biographies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"published_version_id" uuid,
	"latest_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "content_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_version_id" uuid NOT NULL,
	"target_locale" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"method" "translation_method" NOT NULL,
	"status" "translation_status" DEFAULT 'draft' NOT NULL,
	"reviewer_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_type" "content_type" NOT NULL,
	"content_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"source_locale" text NOT NULL,
	"author_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"occurred_on" date,
	"occurred_precision" date_precision DEFAULT 'unknown' NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"published_version_id" uuid,
	"latest_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"author_user_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"published_version_id" uuid,
	"latest_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "visitor_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"submitter_user_id" uuid,
	"kind" "submission_kind" NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"source_locale" text NOT NULL,
	"status" "content_status" DEFAULT 'pending_review' NOT NULL,
	"moderated_by_user_id" uuid,
	"moderated_at" timestamp with time zone,
	"moderation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "biographies" ADD CONSTRAINT "biographies_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biographies" ADD CONSTRAINT "biographies_published_version_id_content_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."content_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_translations" ADD CONSTRAINT "content_translations_content_version_id_content_versions_id_fk" FOREIGN KEY ("content_version_id") REFERENCES "public"."content_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_translations" ADD CONSTRAINT "content_translations_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_published_version_id_content_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."content_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tributes" ADD CONSTRAINT "tributes_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tributes" ADD CONSTRAINT "tributes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tributes" ADD CONSTRAINT "tributes_published_version_id_content_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."content_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_submissions" ADD CONSTRAINT "visitor_submissions_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_submissions" ADD CONSTRAINT "visitor_submissions_submitter_user_id_users_id_fk" FOREIGN KEY ("submitter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_submissions" ADD CONSTRAINT "visitor_submissions_moderated_by_user_id_users_id_fk" FOREIGN KEY ("moderated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "biographies_memorial_key" ON "biographies" USING btree ("memorial_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_translations_version_locale_key" ON "content_translations" USING btree ("content_version_id","target_locale");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_item_version_key" ON "content_versions" USING btree ("content_type","content_id","version");--> statement-breakpoint
CREATE INDEX "content_versions_item_idx" ON "content_versions" USING btree ("content_type","content_id");--> statement-breakpoint
CREATE INDEX "timeline_events_memorial_idx" ON "timeline_events" USING btree ("memorial_id","occurred_on");--> statement-breakpoint
CREATE INDEX "tributes_memorial_idx" ON "tributes" USING btree ("memorial_id","status");--> statement-breakpoint
CREATE INDEX "visitor_submissions_memorial_idx" ON "visitor_submissions" USING btree ("memorial_id","status");