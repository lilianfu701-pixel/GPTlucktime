SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "discovery_snapshot_items" (
	"snapshot_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"candidate_user_id" uuid NOT NULL,
	"candidate_profile_id" uuid NOT NULL,
	"score" double precision NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "discovery_snapshot_items_pk" PRIMARY KEY("snapshot_id","ordinal"),
	CONSTRAINT "discovery_snapshot_items_candidate_unique" UNIQUE("snapshot_id","candidate_profile_id"),
	CONSTRAINT "discovery_snapshot_items_ordinal_check" CHECK ("discovery_snapshot_items"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discovery_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"filter_fingerprint" varchar(64) NOT NULL,
	"ranking_version" varchar(50) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_snapshot_items" ADD CONSTRAINT "discovery_snapshot_items_snapshot_id_discovery_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."discovery_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_snapshot_items" ADD CONSTRAINT "discovery_snapshot_items_candidate_user_id_users_id_fk" FOREIGN KEY ("candidate_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_snapshot_items" ADD CONSTRAINT "discovery_snapshot_items_candidate_profile_id_profiles_id_fk" FOREIGN KEY ("candidate_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_snapshots" ADD CONSTRAINT "discovery_snapshots_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_snapshot_items_candidate_idx" ON "discovery_snapshot_items" USING btree ("candidate_profile_id");--> statement-breakpoint
CREATE INDEX "discovery_snapshots_owner_expiry_idx" ON "discovery_snapshots" USING btree ("owner_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "discovery_snapshots_expiry_idx" ON "discovery_snapshots" USING btree ("expires_at");
