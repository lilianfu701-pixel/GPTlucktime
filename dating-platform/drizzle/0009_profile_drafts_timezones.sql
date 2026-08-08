ALTER TABLE "profiles" ALTER COLUMN "display_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "birth_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "gender_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "country_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "discoverable" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "publish_requested" boolean DEFAULT false NOT NULL;