CREATE TABLE "identity_session_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'identity' NOT NULL,
	"provider" text NOT NULL,
	"idempotency_hash" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"status" text DEFAULT 'initiating' NOT NULL,
	"provider_reference" text,
	"attempt_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_session_intents_idempotency_unique" UNIQUE("user_id","kind","idempotency_hash"),
	CONSTRAINT "identity_session_intents_kind_check" CHECK ("identity_session_intents"."kind" = 'identity'),
	CONSTRAINT "identity_session_intents_status_check" CHECK ("identity_session_intents"."status" IN ('initiating', 'bound', 'compensation_pending', 'compensated', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD COLUMN "redirect_encryption_key_id" text;--> statement-breakpoint
ALTER TABLE "identity_session_intents" ADD CONSTRAINT "identity_session_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_session_intents" ADD CONSTRAINT "identity_session_intents_attempt_id_verification_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."verification_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_session_intents_recovery_idx" ON "identity_session_intents" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "identity_session_intents_attempt_idx" ON "identity_session_intents" USING btree ("attempt_id");