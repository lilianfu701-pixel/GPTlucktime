CREATE TYPE "public"."catalog_lifecycle" AS ENUM('draft', 'in_review', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."compatibility_level" AS ENUM('recommended', 'optional', 'needs_family_confirmation', 'not_recommended', 'prohibited_combination');--> statement-breakpoint
CREATE TYPE "public"."ritual_action_type" AS ENUM('offering', 'light', 'prayer', 'recitation', 'gesture', 'message', 'contribution', 'planting', 'observance', 'custom');--> statement-breakpoint
CREATE TYPE "public"."ritual_source_kind" AS ENUM('scripture', 'scholarly', 'institutional', 'ethnographic', 'community_adviser');--> statement-breakpoint
CREATE TABLE "cultural_traditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"admin_label" text NOT NULL,
	"region_hints" text[],
	"status" "catalog_lifecycle" DEFAULT 'published' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "denominations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"religion_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"admin_label" text NOT NULL,
	"status" "catalog_lifecycle" DEFAULT 'published' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "religions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"admin_label" text NOT NULL,
	"status" "catalog_lifecycle" DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ritual_compatibility_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ritual_version_id" uuid NOT NULL,
	"religion_id" uuid,
	"denomination_id" uuid,
	"culture_id" uuid,
	"country" text,
	"level" "compatibility_level" NOT NULL,
	"explanation_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ritual_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"action_type" "ritual_action_type" NOT NULL,
	"admin_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ritual_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ritual_version_id" uuid NOT NULL,
	"kind" "ritual_source_kind" NOT NULL,
	"citation" text NOT NULL,
	"url" text,
	"adviser_name" text,
	"retrieved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ritual_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ritual_version_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"terminology_note" text,
	"method" text NOT NULL,
	"status" "catalog_lifecycle" DEFAULT 'draft' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ritual_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "catalog_lifecycle" DEFAULT 'draft' NOT NULL,
	"applies_to_religion_id" uuid,
	"applies_to_denomination_id" uuid,
	"applies_to_culture_id" uuid,
	"applies_to_countries" text[],
	"out_of_scope_note" text,
	"allow_anonymous" boolean DEFAULT false NOT NULL,
	"allow_message" boolean DEFAULT true NOT NULL,
	"suggest_pre_review" boolean DEFAULT true NOT NULL,
	"calendar_id" text,
	"anniversary_rule" text,
	"conflict_tags" text[],
	"authored_by_user_id" uuid,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"retirement_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "denominations" ADD CONSTRAINT "denominations_religion_id_religions_id_fk" FOREIGN KEY ("religion_id") REFERENCES "public"."religions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_compatibility_rules" ADD CONSTRAINT "ritual_compatibility_rules_ritual_version_id_ritual_versions_id_fk" FOREIGN KEY ("ritual_version_id") REFERENCES "public"."ritual_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_compatibility_rules" ADD CONSTRAINT "ritual_compatibility_rules_religion_id_religions_id_fk" FOREIGN KEY ("religion_id") REFERENCES "public"."religions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_compatibility_rules" ADD CONSTRAINT "ritual_compatibility_rules_denomination_id_denominations_id_fk" FOREIGN KEY ("denomination_id") REFERENCES "public"."denominations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_compatibility_rules" ADD CONSTRAINT "ritual_compatibility_rules_culture_id_cultural_traditions_id_fk" FOREIGN KEY ("culture_id") REFERENCES "public"."cultural_traditions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_sources" ADD CONSTRAINT "ritual_sources_ritual_version_id_ritual_versions_id_fk" FOREIGN KEY ("ritual_version_id") REFERENCES "public"."ritual_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_translations" ADD CONSTRAINT "ritual_translations_ritual_version_id_ritual_versions_id_fk" FOREIGN KEY ("ritual_version_id") REFERENCES "public"."ritual_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_translations" ADD CONSTRAINT "ritual_translations_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_versions" ADD CONSTRAINT "ritual_versions_definition_id_ritual_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."ritual_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_versions" ADD CONSTRAINT "ritual_versions_applies_to_religion_id_religions_id_fk" FOREIGN KEY ("applies_to_religion_id") REFERENCES "public"."religions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_versions" ADD CONSTRAINT "ritual_versions_applies_to_denomination_id_denominations_id_fk" FOREIGN KEY ("applies_to_denomination_id") REFERENCES "public"."denominations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_versions" ADD CONSTRAINT "ritual_versions_applies_to_culture_id_cultural_traditions_id_fk" FOREIGN KEY ("applies_to_culture_id") REFERENCES "public"."cultural_traditions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_versions" ADD CONSTRAINT "ritual_versions_authored_by_user_id_users_id_fk" FOREIGN KEY ("authored_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_versions" ADD CONSTRAINT "ritual_versions_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_versions" ADD CONSTRAINT "ritual_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cultural_traditions_slug_key" ON "cultural_traditions" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "denominations_slug_key" ON "denominations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "religions_slug_key" ON "religions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ritual_compatibility_version_idx" ON "ritual_compatibility_rules" USING btree ("ritual_version_id");--> statement-breakpoint
CREATE INDEX "ritual_compatibility_religion_idx" ON "ritual_compatibility_rules" USING btree ("religion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ritual_definitions_slug_key" ON "ritual_definitions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ritual_sources_version_idx" ON "ritual_sources" USING btree ("ritual_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ritual_translations_version_locale_key" ON "ritual_translations" USING btree ("ritual_version_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "ritual_versions_definition_version_key" ON "ritual_versions" USING btree ("definition_id","version");--> statement-breakpoint
CREATE INDEX "ritual_versions_status_idx" ON "ritual_versions" USING btree ("status");