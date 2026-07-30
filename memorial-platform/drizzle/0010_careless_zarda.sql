CREATE TYPE "public"."duplicate_status" AS ENUM('open', 'dismissed', 'merged');--> statement-breakpoint
CREATE TABLE "duplicate_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"candidate_memorial_id" uuid NOT NULL,
	"score" real NOT NULL,
	"component_scores" jsonb NOT NULL,
	"status" "duplicate_status" DEFAULT 'open' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"memorial_id" uuid PRIMARY KEY NOT NULL,
	"normalized_text" text NOT NULL,
	"aliases" text[],
	"country_codes" text[],
	"place_tokens" text[],
	"birth_year" integer,
	"death_year" integer,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_candidate_memorial_id_memorials_id_fk" FOREIGN KEY ("candidate_memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_candidates_pair_key" ON "duplicate_candidates" USING btree ("memorial_id","candidate_memorial_id");--> statement-breakpoint
CREATE INDEX "duplicate_candidates_status_idx" ON "duplicate_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "search_documents_birth_year_idx" ON "search_documents" USING btree ("birth_year");--> statement-breakpoint
CREATE INDEX "search_documents_death_year_idx" ON "search_documents" USING btree ("death_year");