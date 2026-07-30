CREATE TYPE "public"."platform_role" AS ENUM('user', 'reviewer', 'super_admin');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platform_role" "platform_role" DEFAULT 'user' NOT NULL;