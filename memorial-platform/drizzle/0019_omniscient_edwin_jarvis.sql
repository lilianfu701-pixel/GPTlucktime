CREATE TYPE "public"."family_match_decision" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."family_match_status" AS ENUM('open', 'matched', 'dismissed');--> statement-breakpoint
CREATE TABLE "family_match_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"older_person_id" uuid NOT NULL,
	"newer_person_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"signals" text NOT NULL,
	"older_decision" "family_match_decision" DEFAULT 'pending' NOT NULL,
	"newer_decision" "family_match_decision" DEFAULT 'pending' NOT NULL,
	"status" "family_match_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "family_match_distinct_ck" CHECK ("family_match_suggestions"."older_person_id" <> "family_match_suggestions"."newer_person_id")
);
--> statement-breakpoint
ALTER TABLE "family_people" ADD COLUMN "merged_into_person_id" uuid;--> statement-breakpoint
ALTER TABLE "family_match_suggestions" ADD CONSTRAINT "family_match_suggestions_older_person_id_family_people_id_fk" FOREIGN KEY ("older_person_id") REFERENCES "public"."family_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_match_suggestions" ADD CONSTRAINT "family_match_suggestions_newer_person_id_family_people_id_fk" FOREIGN KEY ("newer_person_id") REFERENCES "public"."family_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_match_pair_key" ON "family_match_suggestions" USING btree ("older_person_id","newer_person_id");--> statement-breakpoint
CREATE INDEX "family_match_older_idx" ON "family_match_suggestions" USING btree ("older_person_id","status");--> statement-breakpoint
CREATE INDEX "family_match_newer_idx" ON "family_match_suggestions" USING btree ("newer_person_id","status");