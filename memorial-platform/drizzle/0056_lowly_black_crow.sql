ALTER TABLE "family_people" ADD COLUMN "generation_name" text;--> statement-breakpoint
ALTER TABLE "family_people" ADD COLUMN "public_masked" boolean DEFAULT false NOT NULL;