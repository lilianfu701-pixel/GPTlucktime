SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "profile_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viewer_user_id" uuid NOT NULL,
	"viewed_user_id" uuid NOT NULL,
	"view_count" integer DEFAULT 1 NOT NULL,
	"first_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_views_direction_unique" UNIQUE("viewer_user_id","viewed_user_id"),
	CONSTRAINT "profile_views_not_self_check" CHECK ("profile_views"."viewer_user_id" <> "profile_views"."viewed_user_id"),
	CONSTRAINT "profile_views_count_check" CHECK ("profile_views"."view_count" > 0 AND "profile_views"."view_count" <= 2147483647)
);
--> statement-breakpoint
CREATE TABLE "realtime_pair_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"low_user_id" uuid NOT NULL,
	"high_user_id" uuid NOT NULL,
	"revoked_before" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realtime_pair_revocations_pair_unique" UNIQUE("low_user_id","high_user_id"),
	CONSTRAINT "realtime_pair_revocations_ordered_pair_check" CHECK ("realtime_pair_revocations"."low_user_id" < "realtime_pair_revocations"."high_user_id"),
	CONSTRAINT "realtime_pair_revocations_version_check" CHECK ("realtime_pair_revocations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "social_action_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"action" text NOT NULL,
	"target_profile_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_action_idempotency_actor_key_unique" UNIQUE("actor_user_id","key_hash"),
	CONSTRAINT "social_action_idempotency_action_check" CHECK ("social_action_idempotency"."action" IN ('like', 'favorite', 'view', 'block'))
);
--> statement-breakpoint
CREATE TABLE "social_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_favorites_direction_unique" UNIQUE("owner_user_id","target_user_id"),
	CONSTRAINT "social_favorites_not_self_check" CHECK ("social_favorites"."owner_user_id" <> "social_favorites"."target_user_id")
);
--> statement-breakpoint
CREATE TABLE "social_likes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "social_likes_direction_unique" UNIQUE("actor_user_id","target_user_id"),
	CONSTRAINT "social_likes_not_self_check" CHECK ("social_likes"."actor_user_id" <> "social_likes"."target_user_id")
);
--> statement-breakpoint
CREATE TABLE "social_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"low_user_id" uuid NOT NULL,
	"high_user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "social_matches_pair_unique" UNIQUE("low_user_id","high_user_id"),
	CONSTRAINT "social_matches_ordered_pair_check" CHECK ("social_matches"."low_user_id" < "social_matches"."high_user_id"),
	CONSTRAINT "social_matches_status_check" CHECK ("social_matches"."status" IN ('active', 'hidden', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "social_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_outbox_event_type_check" CHECK ("social_outbox_events"."event_type" IN ('match.created')),
	CONSTRAINT "social_outbox_status_check" CHECK ("social_outbox_events"."status" IN ('pending', 'processing', 'published', 'failed')),
	CONSTRAINT "social_outbox_attempts_check" CHECK ("social_outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewer_user_id_users_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewed_user_id_users_id_fk" FOREIGN KEY ("viewed_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realtime_pair_revocations" ADD CONSTRAINT "realtime_pair_revocations_low_user_id_users_id_fk" FOREIGN KEY ("low_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realtime_pair_revocations" ADD CONSTRAINT "realtime_pair_revocations_high_user_id_users_id_fk" FOREIGN KEY ("high_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_action_idempotency" ADD CONSTRAINT "social_action_idempotency_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_action_idempotency" ADD CONSTRAINT "social_action_idempotency_target_profile_id_profiles_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_favorites" ADD CONSTRAINT "social_favorites_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_favorites" ADD CONSTRAINT "social_favorites_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_likes" ADD CONSTRAINT "social_likes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_likes" ADD CONSTRAINT "social_likes_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_matches" ADD CONSTRAINT "social_matches_low_user_id_users_id_fk" FOREIGN KEY ("low_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_matches" ADD CONSTRAINT "social_matches_high_user_id_users_id_fk" FOREIGN KEY ("high_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_views_owner_recent_idx" ON "profile_views" USING btree ("viewed_user_id","last_viewed_at");--> statement-breakpoint
CREATE INDEX "social_action_idempotency_created_idx" ON "social_action_idempotency" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "social_favorites_owner_created_idx" ON "social_favorites" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "social_likes_received_idx" ON "social_likes" USING btree ("target_user_id","active","created_at");--> statement-breakpoint
CREATE INDEX "social_likes_sent_idx" ON "social_likes" USING btree ("actor_user_id","active","created_at");--> statement-breakpoint
CREATE INDEX "social_matches_low_status_idx" ON "social_matches" USING btree ("low_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "social_matches_high_status_idx" ON "social_matches" USING btree ("high_user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_outbox_dedupe_unique" ON "social_outbox_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "social_outbox_claim_idx" ON "social_outbox_events" USING btree ("status","available_at","lease_expires_at");
