CREATE TYPE "public"."relationship_category" AS ENUM('spouse', 'parent_child', 'sibling', 'grandparent_grandchild', 'great_grandparent', 'paternal_extended', 'maternal_extended', 'cousin', 'nibling', 'in_law_spouse_family', 'in_law_sibling_child_spouse', 'step_adoptive');--> statement-breakpoint
CREATE TABLE "relationship_types" (
	"key" text PRIMARY KEY NOT NULL,
	"category" "relationship_category" NOT NULL,
	"gender" text,
	"generation_offset" integer NOT NULL,
	"is_blood" boolean DEFAULT true NOT NULL,
	"is_marital" boolean DEFAULT false NOT NULL,
	"reverse_key" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
