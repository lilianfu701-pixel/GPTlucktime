CREATE TYPE "public"."date_precision" AS ENUM('day', 'month', 'year', 'approximate', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."memorial_location_kind" AS ENUM('birth', 'death', 'lived', 'resting_place');--> statement-breakpoint
CREATE TYPE "public"."memorial_member_role" AS ENUM('owner', 'admin', 'editor', 'reviewer', 'invited_visitor');--> statement-breakpoint
CREATE TYPE "public"."memorial_name_type" AS ENUM('primary', 'former', 'native', 'transliteration', 'alias');--> statement-breakpoint
CREATE TYPE "public"."memorial_status" AS ENUM('draft', 'published', 'restricted', 'hidden', 'pending_deletion');--> statement-breakpoint
CREATE TYPE "public"."memorial_visibility" AS ENUM('public', 'unlisted', 'invite_only');--> statement-breakpoint
CREATE TYPE "public"."relationship_claim_status" AS ENUM('declared', 'disputed', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."relationship_kind" AS ENUM('spouse', 'parent', 'child', 'sibling');--> statement-breakpoint
CREATE TABLE "deceased_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"birth_date" date,
	"birth_date_precision" date_precision DEFAULT 'unknown' NOT NULL,
	"death_date" date,
	"death_date_precision" date_precision DEFAULT 'unknown' NOT NULL,
	"gender" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memorial_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"kind" "memorial_location_kind" NOT NULL,
	"country" text,
	"region" text,
	"city" text
);
--> statement-breakpoint
CREATE TABLE "memorial_members" (
	"memorial_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "memorial_member_role" NOT NULL,
	"invited_by" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memorial_members_memorial_id_user_id_pk" PRIMARY KEY("memorial_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "memorial_names" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"value" text NOT NULL,
	"locale" text,
	"script" text,
	"type" "memorial_name_type" DEFAULT 'primary' NOT NULL,
	"searchable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memorials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deceased_person_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" "memorial_status" DEFAULT 'draft' NOT NULL,
	"visibility" "memorial_visibility" DEFAULT 'public' NOT NULL,
	"search_engine_indexable" boolean DEFAULT true NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"creation_idempotency_key" text,
	"published_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"claimant_user_id" uuid NOT NULL,
	"relationship" "relationship_kind" NOT NULL,
	"statement_version" text NOT NULL,
	"status" "relationship_claim_status" DEFAULT 'declared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memorial_locations" ADD CONSTRAINT "memorial_locations_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_members" ADD CONSTRAINT "memorial_members_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_members" ADD CONSTRAINT "memorial_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_members" ADD CONSTRAINT "memorial_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_names" ADD CONSTRAINT "memorial_names_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorials" ADD CONSTRAINT "memorials_deceased_person_id_deceased_people_id_fk" FOREIGN KEY ("deceased_person_id") REFERENCES "public"."deceased_people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorials" ADD CONSTRAINT "memorials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_claims" ADD CONSTRAINT "relationship_claims_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_claims" ADD CONSTRAINT "relationship_claims_claimant_user_id_users_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memorial_locations_memorial_idx" ON "memorial_locations" USING btree ("memorial_id");--> statement-breakpoint
CREATE INDEX "memorial_members_user_idx" ON "memorial_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memorial_names_memorial_idx" ON "memorial_names" USING btree ("memorial_id");--> statement-breakpoint
CREATE INDEX "memorial_names_value_idx" ON "memorial_names" USING btree ("value");--> statement-breakpoint
CREATE UNIQUE INDEX "memorials_slug_key" ON "memorials" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "memorials_owner_idempotency_key" ON "memorials" USING btree ("owner_user_id","creation_idempotency_key");--> statement-breakpoint
CREATE INDEX "memorials_owner_idx" ON "memorials" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "memorials_visibility_idx" ON "memorials" USING btree ("visibility","status");--> statement-breakpoint
CREATE INDEX "memorials_purge_idx" ON "memorials" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "relationship_claims_memorial_idx" ON "relationship_claims" USING btree ("memorial_id");--> statement-breakpoint
CREATE INDEX "relationship_claims_claimant_idx" ON "relationship_claims" USING btree ("claimant_user_id");