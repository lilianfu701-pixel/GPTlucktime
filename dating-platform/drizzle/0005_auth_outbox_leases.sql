ALTER TABLE "auth_notification_deliveries" ADD COLUMN "encryption_key_id" text;--> statement-breakpoint
ALTER TABLE "auth_notification_deliveries" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_notification_deliveries" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "auth_notification_due_lease_idx" ON "auth_notification_deliveries" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "auth_notification_retention_idx" ON "auth_notification_deliveries" USING btree ("status","updated_at");