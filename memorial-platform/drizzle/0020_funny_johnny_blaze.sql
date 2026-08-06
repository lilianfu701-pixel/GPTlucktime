ALTER TYPE "public"."relationship_kind" ADD VALUE 'husband';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'wife';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'father';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'mother';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'son';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'daughter';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'older_sister';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'older_brother';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'younger_brother';--> statement-breakpoint
ALTER TYPE "public"."relationship_kind" ADD VALUE 'younger_sister';--> statement-breakpoint
CREATE TABLE "memorial_relatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relationship_to_deceased" text NOT NULL,
	"is_deceased" boolean DEFAULT false NOT NULL,
	"show_full_name" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deceased_people" ADD COLUMN "ancestral_hometown" text;--> statement-breakpoint
ALTER TABLE "deceased_people" ADD COLUMN "faith" text;--> statement-breakpoint
ALTER TABLE "deceased_people" ADD COLUMN "cause_of_death" text;--> statement-breakpoint
ALTER TABLE "memorial_relatives" ADD CONSTRAINT "memorial_relatives_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memorial_relatives_memorial_idx" ON "memorial_relatives" USING btree ("memorial_id");