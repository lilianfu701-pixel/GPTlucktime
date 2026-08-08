SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "social_action_idempotency" DROP CONSTRAINT "social_action_idempotency_target_profile_id_profiles_id_fk";
--> statement-breakpoint
CREATE INDEX "social_action_idempotency_owner_created_idx" ON "social_action_idempotency" USING btree ("actor_user_id","created_at");
