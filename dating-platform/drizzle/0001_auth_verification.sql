CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "verification_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"attempt_id" uuid,
	"provider_reference" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_webhook_events_provider_event_unique" UNIQUE("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_number_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_webhook_events" ADD CONSTRAINT "verification_webhook_events_attempt_id_verification_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."verification_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "two_factors_secret_idx" ON "two_factors" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factors_user_idx" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_webhook_events_reference_idx" ON "verification_webhook_events" USING btree ("provider","provider_reference");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number");--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_provider_reference_unique" UNIQUE("provider","provider_reference");