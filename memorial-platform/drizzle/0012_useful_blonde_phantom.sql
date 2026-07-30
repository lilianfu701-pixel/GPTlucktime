CREATE TYPE "public"."case_status" AS ENUM('open', 'triaged', 'investigating', 'resolved', 'dismissed', 'appealed');--> statement-breakpoint
CREATE TYPE "public"."moderation_action_kind" AS ENUM('restrict_editing', 'restrict_interactions', 'temporarily_hide', 'restore', 'block_user', 'merge_duplicate', 'transfer_ownership', 'freeze_ownership', 'resolve_dispute', 'access_dispute_evidence');--> statement-breakpoint
CREATE TYPE "public"."report_category" AS ENUM('identity_impersonation', 'false_death', 'privacy_violation', 'harassment_or_hate', 'violent_or_explicit', 'spam', 'copyright', 'religious_or_cultural_error', 'ownership_dispute', 'other_safety');--> statement-breakpoint
ALTER TYPE "public"."memorial_status" ADD VALUE 'merged';--> statement-breakpoint
CREATE TABLE "dispute_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"uploaded_by_user_id" uuid,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memorial_slug_redirects" (
	"slug" text PRIMARY KEY NOT NULL,
	"memorial_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"actor_user_id" uuid,
	"action" "moderation_action_kind" NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid,
	"kind" text NOT NULL,
	"status" "case_status" DEFAULT 'open' NOT NULL,
	"assigned_reviewer_id" uuid,
	"resolution" text,
	"appeal_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ownership_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"claimant_user_id" uuid NOT NULL,
	"claimed_relationship" "relationship_kind" NOT NULL,
	"statement" text NOT NULL,
	"case_id" uuid,
	"status" "case_status" DEFAULT 'open' NOT NULL,
	"outcome" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"appealed_at" timestamp with time zone,
	"appeal_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"category" "report_category" NOT NULL,
	"description" text,
	"reporter_user_id" uuid,
	"contact_email" text,
	"status" "case_status" DEFAULT 'open' NOT NULL,
	"case_id" uuid,
	"request_ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memorials" ADD COLUMN "merged_into_memorial_id" uuid;--> statement-breakpoint
ALTER TABLE "memorials" ADD COLUMN "ownership_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memorials" ADD COLUMN "editing_restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memorials" ADD COLUMN "interactions_restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_ownership_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."ownership_disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_slug_redirects" ADD CONSTRAINT "memorial_slug_redirects_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_assigned_reviewer_id_users_id_fk" FOREIGN KEY ("assigned_reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_disputes" ADD CONSTRAINT "ownership_disputes_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_disputes" ADD CONSTRAINT "ownership_disputes_claimant_user_id_users_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_disputes" ADD CONSTRAINT "ownership_disputes_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_disputes" ADD CONSTRAINT "ownership_disputes_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispute_evidence_dispute_idx" ON "dispute_evidence" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "memorial_slug_redirects_memorial_idx" ON "memorial_slug_redirects" USING btree ("memorial_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_case_idx" ON "moderation_actions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_resource_idx" ON "moderation_actions" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "moderation_cases_status_idx" ON "moderation_cases" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_disputes_open_claim_key" ON "ownership_disputes" USING btree ("memorial_id","claimant_user_id");--> statement-breakpoint
CREATE INDEX "ownership_disputes_memorial_idx" ON "ownership_disputes" USING btree ("memorial_id");--> statement-breakpoint
CREATE INDEX "reports_resource_idx" ON "reports" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","created_at");