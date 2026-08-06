CREATE TYPE "public"."recognition_claim_status" AS ENUM('pending', 'escalated', 'confirmed', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."dissolution_reason" AS ENUM('divorce', 'widowed', 'separation', 'annulment');--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'ex_husband' BEFORE 'father';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'ex_wife' BEFORE 'father';--> statement-breakpoint
CREATE TABLE "recognition_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"claimant_user_id" uuid NOT NULL,
	"claimed_name" text NOT NULL,
	"claimed_relationship" text NOT NULL,
	"status" "recognition_claim_status" DEFAULT 'pending' NOT NULL,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_links" ADD COLUMN "dissolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "family_links" ADD COLUMN "dissolution_reason" "dissolution_reason";--> statement-breakpoint
ALTER TABLE "recognition_claims" ADD CONSTRAINT "recognition_claims_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_claims" ADD CONSTRAINT "recognition_claims_claimant_user_id_users_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_claims" ADD CONSTRAINT "recognition_claims_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recognition_claims_memorial_idx" ON "recognition_claims" USING btree ("memorial_id");--> statement-breakpoint
CREATE INDEX "recognition_claims_claimant_idx" ON "recognition_claims" USING btree ("claimant_user_id");--> statement-breakpoint
CREATE INDEX "recognition_claims_status_idx" ON "recognition_claims" USING btree ("status");--> statement-breakpoint
ALTER TABLE "family_links" ADD CONSTRAINT "family_links_dissolution_ck" CHECK ("family_links"."kind" = 'partner' or ("family_links"."dissolved_at" is null and "family_links"."dissolution_reason" is null));