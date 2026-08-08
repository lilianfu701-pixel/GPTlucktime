SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ADD COLUMN "build_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ADD COLUMN "build_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "discovery_snapshots_build_lease_idx" ON "discovery_snapshots" USING btree ("status","build_lease_expires_at");
