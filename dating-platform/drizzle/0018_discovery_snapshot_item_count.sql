SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ADD COLUMN "item_count" integer;--> statement-breakpoint
UPDATE "discovery_snapshots" AS "snapshot"
SET "item_count" = (
	SELECT count(*)::integer
	FROM "discovery_snapshot_items" AS "item"
	WHERE "item"."snapshot_id" = "snapshot"."id"
);--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ALTER COLUMN "item_count" SET NOT NULL;
