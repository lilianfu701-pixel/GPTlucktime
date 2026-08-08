SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ADD COLUMN "item_count" integer NOT NULL;
