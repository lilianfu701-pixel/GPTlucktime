CREATE TABLE "auth_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"delivery_key" text NOT NULL,
	"recipient_encrypted" text,
	"payload_encrypted" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_notification_kind_check" CHECK ("auth_notification_deliveries"."kind" in ('email_verification', 'sms_otp')),
	CONSTRAINT "auth_notification_status_check" CHECK ("auth_notification_deliveries"."status" in ('pending', 'processing', 'sent', 'failed', 'expired')),
	CONSTRAINT "auth_notification_attempts_check" CHECK ("auth_notification_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_notification_delivery_key_unique" ON "auth_notification_deliveries" USING btree ("delivery_key");--> statement-breakpoint
CREATE INDEX "auth_notification_due_idx" ON "auth_notification_deliveries" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "auth_notification_expiry_idx" ON "auth_notification_deliveries" USING btree ("expires_at");