SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ADD COLUMN "status" text DEFAULT 'building' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ADD COLUMN "truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "discovery_snapshots_owner_created_idx" ON "discovery_snapshots" USING btree ("owner_user_id","created_at");--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ADD CONSTRAINT "discovery_snapshots_status_check" CHECK ("discovery_snapshots"."status" IN ('building', 'ready'));
