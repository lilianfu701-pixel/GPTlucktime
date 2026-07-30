CREATE TYPE "public"."commemoration_status" AS ENUM('visible', 'pending_review', 'rejected', 'hidden');--> statement-breakpoint
CREATE TABLE "commemoration_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commemoration_id" uuid NOT NULL,
	"body" text NOT NULL,
	"source_locale" text NOT NULL,
	"moderation_status" "commemoration_status" DEFAULT 'pending_review' NOT NULL,
	"moderated_by_user_id" uuid,
	"moderated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commemorations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"ritual_version_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"anonymous" boolean DEFAULT false NOT NULL,
	"locale" text NOT NULL,
	"status" "commemoration_status" DEFAULT 'visible' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "blocked_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"blocked_by_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "commemoration_messages" ADD CONSTRAINT "commemoration_messages_commemoration_id_commemorations_id_fk" FOREIGN KEY ("commemoration_id") REFERENCES "public"."commemorations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commemoration_messages" ADD CONSTRAINT "commemoration_messages_moderated_by_user_id_users_id_fk" FOREIGN KEY ("moderated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commemorations" ADD CONSTRAINT "commemorations_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commemorations" ADD CONSTRAINT "commemorations_ritual_version_id_ritual_versions_id_fk" FOREIGN KEY ("ritual_version_id") REFERENCES "public"."ritual_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commemorations" ADD CONSTRAINT "commemorations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_blocked_user_id_users_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_blocked_by_user_id_users_id_fk" FOREIGN KEY ("blocked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commemoration_messages_commemoration_key" ON "commemoration_messages" USING btree ("commemoration_id");--> statement-breakpoint
CREATE INDEX "commemoration_messages_status_idx" ON "commemoration_messages" USING btree ("moderation_status");--> statement-breakpoint
CREATE UNIQUE INDEX "commemorations_memorial_idempotency_key" ON "commemorations" USING btree ("memorial_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "commemorations_memorial_idx" ON "commemorations" USING btree ("memorial_id","status");--> statement-breakpoint
CREATE INDEX "commemorations_actor_idx" ON "commemorations" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "commemorations_ip_idx" ON "commemorations" USING btree ("request_ip_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_users_memorial_user_key" ON "blocked_users" USING btree ("memorial_id","blocked_user_id");--> statement-breakpoint
CREATE INDEX "blocked_users_memorial_idx" ON "blocked_users" USING btree ("memorial_id");