CREATE TABLE "admin_action_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"action" varchar(80) NOT NULL,
	"target_type" varchar(80) NOT NULL,
	"target_id" varchar(200) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"expected_version" integer NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_action_idempotency_actor_key_unique" UNIQUE("actor_user_id","idempotency_key"),
	CONSTRAINT "admin_action_idempotency_hash_check" CHECK (char_length("admin_action_idempotency"."payload_hash") = 64),
	CONSTRAINT "admin_action_idempotency_version_check" CHECK ("admin_action_idempotency"."expected_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin_approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"approver_admin_session_id" uuid NOT NULL,
	"permission" varchar(100) NOT NULL,
	"decision" text NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_approval_decisions_request_unique" UNIQUE("request_id"),
	CONSTRAINT "admin_approval_decisions_decision_check" CHECK ("admin_approval_decisions"."decision" IN ('approved','rejected')),
	CONSTRAINT "admin_approval_decisions_reason_check" CHECK (char_length("admin_approval_decisions"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "admin_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"requester_admin_session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"ip_hash" varchar(64) NOT NULL,
	"action" text NOT NULL,
	"request_permission" varchar(100) NOT NULL,
	"approval_permission" varchar(100) NOT NULL,
	"target_type" varchar(80) NOT NULL,
	"target_id" varchar(200) NOT NULL,
	"payload_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"manual_review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_approval_requests_action_check" CHECK ("admin_approval_requests"."action" IN ('bulk_suspension','sensitive_export','manual_refund','payment_configuration','safety_evidence_access')),
	CONSTRAINT "admin_approval_requests_version_check" CHECK ("admin_approval_requests"."payload_version" > 0),
	CONSTRAINT "admin_approval_requests_hash_check" CHECK (char_length("admin_approval_requests"."payload_hash") = 64),
	CONSTRAINT "admin_approval_requests_ip_hash_check" CHECK (char_length("admin_approval_requests"."ip_hash") = 64),
	CONSTRAINT "admin_approval_requests_reason_check" CHECK (char_length("admin_approval_requests"."reason") BETWEEN 1 AND 500),
	CONSTRAINT "admin_approval_requests_status_check" CHECK ("admin_approval_requests"."status" IN ('pending','approved','rejected','executing','executed','expired','failed')),
	CONSTRAINT "admin_approval_requests_expiry_check" CHECK ("admin_approval_requests"."expires_at" > "admin_approval_requests"."created_at"),
	CONSTRAINT "admin_approval_requests_attempts_check" CHECK ("admin_approval_requests"."attempts" BETWEEN 0 AND 20),
	CONSTRAINT "admin_approval_requests_lease_shape_check" CHECK (
    ("admin_approval_requests"."status" = 'executing' AND "admin_approval_requests"."lease_id" IS NOT NULL AND "admin_approval_requests"."lease_expires_at" IS NOT NULL)
    OR ("admin_approval_requests"."status" <> 'executing' AND "admin_approval_requests"."lease_id" IS NULL AND "admin_approval_requests"."lease_expires_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"permission" varchar(100) NOT NULL,
	"target_type" varchar(80) NOT NULL,
	"target_id" varchar(200) NOT NULL,
	"before_diff" jsonb NOT NULL,
	"after_diff" jsonb NOT NULL,
	"reason" varchar(500) NOT NULL,
	"request_id" uuid NOT NULL,
	"ip_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_logs_hash_check" CHECK (char_length("admin_audit_logs"."ip_hash") = 64),
	CONSTRAINT "admin_audit_logs_reason_check" CHECK (char_length("admin_audit_logs"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "admin_bulk_action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"expected_version" integer NOT NULL,
	"result_action_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_bulk_action_items_request_target_unique" UNIQUE("approval_request_id","target_user_id"),
	CONSTRAINT "admin_bulk_action_items_version_check" CHECK ("admin_bulk_action_items"."expected_version" >= 0),
	CONSTRAINT "admin_bulk_action_items_status_check" CHECK ("admin_bulk_action_items"."status" IN ('pending','claimed','executed','retry','manual_review')),
	CONSTRAINT "admin_bulk_action_items_attempts_check" CHECK ("admin_bulk_action_items"."attempts" BETWEEN 0 AND 20)
);
--> statement-breakpoint
CREATE TABLE "admin_config_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"approval_request_id" uuid,
	"config_type" varchar(80) NOT NULL,
	"target_id" varchar(200) NOT NULL,
	"previous_version" integer NOT NULL,
	"new_version" integer NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_config_changes_actor_key_unique" UNIQUE("actor_user_id","idempotency_key"),
	CONSTRAINT "admin_config_changes_version_check" CHECK ("admin_config_changes"."previous_version" >= 0 AND "admin_config_changes"."new_version" = "admin_config_changes"."previous_version" + 1),
	CONSTRAINT "admin_config_changes_hash_check" CHECK (char_length("admin_config_changes"."payload_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "admin_export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"export_kind" varchar(80) NOT NULL,
	"scope" jsonb NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"object_key" varchar(512),
	"artifact_version" integer,
	"storage_version_id" varchar(255),
	"content_hash" varchar(64),
	"size_bytes" bigint,
	"expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"manual_review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_export_jobs_approval_unique" UNIQUE("approval_request_id"),
	CONSTRAINT "admin_export_jobs_status_check" CHECK ("admin_export_jobs"."status" IN ('queued','processing','ready','purging','purged','failed','manual_review')),
	CONSTRAINT "admin_export_jobs_hash_check" CHECK (char_length("admin_export_jobs"."payload_hash") = 64),
	CONSTRAINT "admin_export_jobs_attempts_check" CHECK ("admin_export_jobs"."attempts" BETWEEN 0 AND 20),
	CONSTRAINT "admin_export_jobs_ready_shape_check" CHECK ("admin_export_jobs"."status" NOT IN ('ready','purging','purged') OR
		("admin_export_jobs"."object_key" IS NOT NULL AND "admin_export_jobs"."artifact_version" = 1
		AND "admin_export_jobs"."storage_version_id" IS NOT NULL AND char_length("admin_export_jobs"."content_hash") = 64
		AND "admin_export_jobs"."size_bytes" > 0 AND "admin_export_jobs"."expires_at" > "admin_export_jobs"."created_at")),
	CONSTRAINT "admin_export_jobs_lease_shape_check" CHECK (
	    ("admin_export_jobs"."status" IN ('processing','purging') AND "admin_export_jobs"."lease_id" IS NOT NULL AND "admin_export_jobs"."lease_expires_at" IS NOT NULL)
	    OR ("admin_export_jobs"."status" NOT IN ('processing','purging') AND "admin_export_jobs"."lease_id" IS NULL AND "admin_export_jobs"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "admin_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" varchar(200) NOT NULL,
	"request_id" uuid NOT NULL,
	"ip_hash" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"delivered_at" timestamp with time zone,
	"manual_review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_outbox_events_status_check" CHECK ("admin_outbox_events"."status" IN ('pending','retrying','processing','delivered','failed')),
	CONSTRAINT "admin_outbox_events_attempts_check" CHECK ("admin_outbox_events"."attempts" BETWEEN 0 AND 20),
	CONSTRAINT "admin_outbox_events_hash_check" CHECK (char_length("admin_outbox_events"."ip_hash") = 64),
	CONSTRAINT "admin_outbox_events_lease_check" CHECK (("admin_outbox_events"."status" = 'processing' AND "admin_outbox_events"."lease_id" IS NOT NULL AND "admin_outbox_events"."lease_expires_at" IS NOT NULL) OR ("admin_outbox_events"."status" <> 'processing' AND "admin_outbox_events"."lease_id" IS NULL AND "admin_outbox_events"."lease_expires_at" IS NULL)),
	CONSTRAINT "admin_outbox_events_terminal_check" CHECK (("admin_outbox_events"."status" = 'delivered' AND "admin_outbox_events"."delivered_at" IS NOT NULL AND "admin_outbox_events"."last_error_code" IS NULL AND "admin_outbox_events"."manual_review_at" IS NULL) OR ("admin_outbox_events"."status" = 'failed' AND "admin_outbox_events"."delivered_at" IS NULL AND "admin_outbox_events"."last_error_code" IS NOT NULL AND "admin_outbox_events"."manual_review_at" IS NOT NULL) OR ("admin_outbox_events"."status" NOT IN ('delivered','failed') AND "admin_outbox_events"."delivered_at" IS NULL AND "admin_outbox_events"."manual_review_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "admin_refund_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_payment_id" varchar(255) NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_refund_id" varchar(255),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_refund_intents_approval_unique" UNIQUE("approval_request_id"),
	CONSTRAINT "admin_refund_intents_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "admin_refund_intents_provider_refund_unique" UNIQUE("provider_refund_id"),
	CONSTRAINT "admin_refund_intents_status_check" CHECK ("admin_refund_intents"."status" IN ('pending','provider_submitted','manual_review')),
	CONSTRAINT "admin_refund_intents_amount_check" CHECK ("admin_refund_intents"."amount" BETWEEN 1 AND 1000000000)
);
--> statement-breakpoint
CREATE TABLE "admin_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"assigned_by_user_id" uuid,
	"active" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_role_assignments_role_check" CHECK ("admin_role_assignments"."role" IN ('support','moderation','safety','operations','finance','super_admin')),
	CONSTRAINT "admin_role_assignments_active_check" CHECK ("admin_role_assignments"."active" IN ('active','revoked')),
	CONSTRAINT "admin_role_assignments_revoked_check" CHECK (("admin_role_assignments"."active" = 'active' AND "admin_role_assignments"."revoked_at" IS NULL) OR ("admin_role_assignments"."active" = 'revoked' AND "admin_role_assignments"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "admin_safety_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"evidence_id" uuid,
	"message_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_safety_access_grants_approval_unique" UNIQUE("approval_request_id"),
	CONSTRAINT "admin_safety_access_grants_target_check" CHECK (num_nonnulls("admin_safety_access_grants"."evidence_id", "admin_safety_access_grants"."message_id") = 1),
	CONSTRAINT "admin_safety_access_grants_expiry_check" CHECK ("admin_safety_access_grants"."expires_at" > "admin_safety_access_grants"."created_at")
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_assignment_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "admin_sessions_token_hash_check" CHECK (char_length("admin_sessions"."token_hash") = 64),
	CONSTRAINT "admin_sessions_expiry_check" CHECK ("admin_sessions"."expires_at" > "admin_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "admin_user_action_versions" (
	"target_user_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_action_versions_version_check" CHECK ("admin_user_action_versions"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "admin_action_idempotency" ADD CONSTRAINT "admin_action_idempotency_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_approval_decisions" ADD CONSTRAINT "admin_approval_decisions_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_approval_decisions" ADD CONSTRAINT "admin_approval_decisions_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_approval_decisions" ADD CONSTRAINT "admin_approval_decisions_approver_admin_session_id_admin_sessions_id_fk" FOREIGN KEY ("approver_admin_session_id") REFERENCES "public"."admin_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_requester_admin_session_id_admin_sessions_id_fk" FOREIGN KEY ("requester_admin_session_id") REFERENCES "public"."admin_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_bulk_action_items" ADD CONSTRAINT "admin_bulk_action_items_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_bulk_action_items" ADD CONSTRAINT "admin_bulk_action_items_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_bulk_action_items" ADD CONSTRAINT "admin_bulk_action_items_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_config_changes" ADD CONSTRAINT "admin_config_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_config_changes" ADD CONSTRAINT "admin_config_changes_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_export_jobs" ADD CONSTRAINT "admin_export_jobs_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_export_jobs" ADD CONSTRAINT "admin_export_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_outbox_events" ADD CONSTRAINT "admin_outbox_events_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_refund_intents" ADD CONSTRAINT "admin_refund_intents_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_refund_intents" ADD CONSTRAINT "admin_refund_intents_payment_id_billing_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."billing_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignments" ADD CONSTRAINT "admin_role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignments" ADD CONSTRAINT "admin_role_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_safety_access_grants" ADD CONSTRAINT "admin_safety_access_grants_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_safety_access_grants" ADD CONSTRAINT "admin_safety_access_grants_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_safety_access_grants" ADD CONSTRAINT "admin_safety_access_grants_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_safety_access_grants" ADD CONSTRAINT "admin_safety_access_grants_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_safety_access_grants" ADD CONSTRAINT "admin_safety_access_grants_evidence_id_moderation_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."moderation_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_safety_access_grants" ADD CONSTRAINT "admin_safety_access_grants_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_role_assignment_id_admin_role_assignments_id_fk" FOREIGN KEY ("role_assignment_id") REFERENCES "public"."admin_role_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_action_versions" ADD CONSTRAINT "admin_user_action_versions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_approval_requests_queue_idx" ON "admin_approval_requests" USING btree ("status","expires_at","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_target_idx" ON "admin_audit_logs" USING btree ("target_type","target_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_actor_idx" ON "admin_audit_logs" USING btree ("actor_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_bulk_action_items_work_idx" ON "admin_bulk_action_items" USING btree ("approval_request_id","status","id");--> statement-breakpoint
CREATE INDEX "admin_config_changes_queue_idx" ON "admin_config_changes" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "admin_export_jobs_queue_idx" ON "admin_export_jobs" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_outbox_events_claim_idx" ON "admin_outbox_events" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "admin_outbox_events_approval_idx" ON "admin_outbox_events" USING btree ("approval_request_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_refund_intents_retry_idx" ON "admin_refund_intents" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_assignments_active_unique" ON "admin_role_assignments" USING btree ("user_id","role") WHERE "admin_role_assignments"."active" = 'active';--> statement-breakpoint
CREATE INDEX "admin_role_assignments_user_idx" ON "admin_role_assignments" USING btree ("user_id","active");--> statement-breakpoint
CREATE INDEX "admin_safety_access_grants_lookup_idx" ON "admin_safety_access_grants" USING btree ("actor_user_id","case_id","expires_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_user_expiry_idx" ON "admin_sessions" USING btree ("user_id","expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_role_has_permission(role_name text, permission_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE role_name
    WHEN 'support' THEN permission_name = ANY (ARRAY['admin.console.read','profile_media.read','verification.failures.read'])
    WHEN 'moderation' THEN permission_name = ANY (ARRAY['admin.console.read','profile_media.read','reports.read','reports.decide','appeals.read','appeals.decide'])
    WHEN 'safety' THEN permission_name = ANY (ARRAY['admin.console.read','profile_media.read','reports.read','reports.decide','appeals.read','appeals.decide','messages.private.read','safety.evidence.request','safety.evidence.approve','users.status.write','users.bulk_suspend.request','users.bulk_suspend.approve','exports.sensitive.request','exports.sensitive.approve'])
    WHEN 'operations' THEN permission_name = ANY (ARRAY['admin.console.read','profile_media.read','verification.failures.read','configuration.changes.read','users.status.write','users.bulk_suspend.request','users.bulk_suspend.approve','entitlements.config.write'])
    WHEN 'finance' THEN permission_name = ANY (ARRAY['admin.console.read','billing.discrepancies.read','billing.refund.request','billing.refund.approve','billing.config.write','billing.config.approve','configuration.changes.read'])
    WHEN 'super_admin' THEN permission_name = ANY (ARRAY['admin.console.read','profile_media.read','reports.read','reports.decide','appeals.read','appeals.decide','billing.discrepancies.read','billing.refund.request','billing.refund.approve','billing.config.write','billing.config.approve','verification.failures.read','configuration.changes.read','entitlements.config.write','users.status.write','users.bulk_suspend.request','users.bulk_suspend.approve','exports.sensitive.request','exports.sensitive.approve','messages.private.read','safety.evidence.request','safety.evidence.approve'])
    ELSE false
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_canonical_jsonb(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(to_jsonb(entry.key)::text || ':' || admin_canonical_jsonb(entry.value),
        ',' ORDER BY entry.key), '') || '}' INTO result FROM jsonb_each(value) entry;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(admin_canonical_jsonb(entry.value), ',' ORDER BY entry.ordinality), '') || ']'
        INTO result FROM jsonb_array_elements(value) WITH ORDINALITY entry(value, ordinality);
    ELSE result := value::text;
  END CASE;
  RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_audit_text_is_sensitive(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR value ~* '([[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}|[0-9]{3}-[0-9]{2}-[0-9]{4}|bearer[[:space:]]+[^[:space:]]+|eyJ[[:alnum:]_-]+\.[[:alnum:]_-]+\.[[:alnum:]_-]+|raw[[:space:]]+message|evidence[[:space:]]+(token|body|content)|(token|secret|password)[[:space:]]*[=:]|(geo|location|coordinates?|lat(itude)?|lon(gitude)?)[[:space:]]*[=:]|-?[0-9]{1,3}\.[0-9]{3,}[[:space:]]*,[[:space:]]*-?[0-9]{1,3}\.[0-9]{3,}|([+]?[0-9][[:space:]().-]*){7,}[0-9])'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_validate_approval_requester() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_session boolean;
BEGIN
  NEW.created_at := CURRENT_TIMESTAMP;
  NEW.updated_at := CURRENT_TIMESTAMP;
  IF NEW.status IS DISTINCT FROM 'pending' OR NEW.attempts <> 0 OR NEW.executed_at IS NOT NULL
    OR NEW.lease_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.last_error_code IS NOT NULL
    OR NEW.manual_review_at IS NOT NULL THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_INITIAL_STATE_INVALID';
  END IF;
  IF length(btrim(NEW.reason)) NOT BETWEEN 1 AND 500
    OR admin_audit_text_is_sensitive(NEW.reason) THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_REASON_INVALID';
  END IF;
  IF NOT (
    (NEW.action = 'bulk_suspension' AND NEW.request_permission = 'users.bulk_suspend.request' AND NEW.approval_permission = 'users.bulk_suspend.approve')
    OR (NEW.action = 'sensitive_export' AND NEW.request_permission = 'exports.sensitive.request' AND NEW.approval_permission = 'exports.sensitive.approve')
    OR (NEW.action = 'manual_refund' AND NEW.request_permission = 'billing.refund.request' AND NEW.approval_permission = 'billing.refund.approve')
    OR (NEW.action = 'payment_configuration' AND NEW.request_permission = 'billing.config.write' AND NEW.approval_permission = 'billing.config.approve')
    OR (NEW.action = 'safety_evidence_access' AND NEW.request_permission = 'safety.evidence.request' AND NEW.approval_permission = 'safety.evidence.approve')
  ) THEN RAISE EXCEPTION 'ADMIN_APPROVAL_PERMISSION_BINDING_INVALID'; END IF;
  IF NEW.action = 'manual_refund' THEN
    IF NEW.target_type IS DISTINCT FROM 'payment'
      OR NEW.target_id IS DISTINCT FROM NEW.payload->>'paymentId'
      OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 2
      OR NOT (NEW.payload ?& ARRAY['paymentId','amount'])
      OR jsonb_typeof(NEW.payload->'paymentId') IS DISTINCT FROM 'string'
      OR COALESCE((NEW.payload->>'paymentId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      OR jsonb_typeof(NEW.payload->'amount') IS DISTINCT FROM 'number'
      OR COALESCE((NEW.payload->>'amount') !~ '^([1-9][0-9]{0,8}|1000000000)$', true) THEN
      RAISE EXCEPTION 'ADMIN_APPROVAL_TARGET_BINDING_INVALID';
    END IF;
  ELSIF NEW.action = 'payment_configuration' THEN
    IF NEW.target_type IS DISTINCT FROM 'billing_price'
      OR NEW.target_id IS DISTINCT FROM concat(NEW.payload->>'planId', ':', NEW.payload->>'countryCode', ':', NEW.payload->>'currency')
      OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 10
      OR NOT (NEW.payload ?& ARRAY['planId','expectedVersion','countryCode','currency','unitAmount','interval',
        'intervalCount','taxMode','providerPriceId','effectiveAt'])
      OR jsonb_typeof(NEW.payload->'planId') IS DISTINCT FROM 'string'
      OR COALESCE((NEW.payload->>'planId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      OR jsonb_typeof(NEW.payload->'expectedVersion') IS DISTINCT FROM 'number'
      OR COALESCE((NEW.payload->>'expectedVersion') !~ '^(0|[1-9][0-9]*)$', true)
      OR jsonb_typeof(NEW.payload->'countryCode') IS DISTINCT FROM 'string'
      OR COALESCE((NEW.payload->>'countryCode') !~ '^[A-Z]{2}$', true)
      OR jsonb_typeof(NEW.payload->'currency') IS DISTINCT FROM 'string'
      OR COALESCE((NEW.payload->>'currency') !~ '^[A-Z]{3}$', true)
      OR jsonb_typeof(NEW.payload->'unitAmount') IS DISTINCT FROM 'number'
      OR COALESCE((NEW.payload->>'unitAmount') !~ '^(0|[1-9][0-9]{0,8}|1000000000)$', true)
      OR jsonb_typeof(NEW.payload->'interval') IS DISTINCT FROM 'string'
      OR COALESCE(NEW.payload->>'interval' NOT IN ('monthly','quarterly','yearly'), true)
      OR jsonb_typeof(NEW.payload->'intervalCount') IS DISTINCT FROM 'number'
      OR COALESCE((NEW.payload->>'intervalCount') !~ '^([1-9]|[12][0-9]|3[0-6])$', true)
      OR jsonb_typeof(NEW.payload->'taxMode') IS DISTINCT FROM 'string'
      OR COALESCE(NEW.payload->>'taxMode' NOT IN ('inclusive','exclusive'), true)
      OR jsonb_typeof(NEW.payload->'providerPriceId') IS DISTINCT FROM 'string'
      OR length(NEW.payload->>'providerPriceId') NOT BETWEEN 3 AND 255
      OR jsonb_typeof(NEW.payload->'effectiveAt') IS DISTINCT FROM 'string'
      OR COALESCE((NEW.payload->>'effectiveAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$', true) THEN
      RAISE EXCEPTION 'ADMIN_APPROVAL_TARGET_BINDING_INVALID';
    END IF;
  ELSIF NEW.action = 'safety_evidence_access' THEN
    IF NEW.target_type IS DISTINCT FROM 'safety_case'
      OR NEW.payload->>'actorUserId' IS DISTINCT FROM NEW.requester_user_id::text
      OR NEW.target_id IS DISTINCT FROM concat(NEW.payload->>'caseId', ':', COALESCE(NEW.payload->>'evidenceId', NEW.payload->>'messageId'))
      OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 5
      OR NOT (NEW.payload ?& ARRAY['actorUserId','caseId','reportId','expiresAt'])
      OR ((NEW.payload ? 'evidenceId') = (NEW.payload ? 'messageId'))
      OR EXISTS (SELECT 1 FROM jsonb_each(NEW.payload) entry
        WHERE entry.key IN ('actorUserId','caseId','reportId','evidenceId','messageId','expiresAt')
          AND jsonb_typeof(entry.value) IS DISTINCT FROM 'string')
      OR COALESCE((NEW.payload->>'actorUserId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      OR COALESCE((NEW.payload->>'caseId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      OR COALESCE((NEW.payload->>'reportId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      OR COALESCE((COALESCE(NEW.payload->>'evidenceId', NEW.payload->>'messageId')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      OR COALESCE((NEW.payload->>'expiresAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$', true)
      OR NOT EXISTS (SELECT 1 FROM moderation_cases c JOIN reports r ON r.id = c.report_id
        WHERE c.id::text = NEW.payload->>'caseId' AND r.id::text = NEW.payload->>'reportId'
          AND ((NEW.payload ? 'messageId' AND r.message_id::text = NEW.payload->>'messageId')
            OR (NEW.payload ? 'evidenceId' AND EXISTS (SELECT 1 FROM moderation_evidence e
              WHERE e.id::text = NEW.payload->>'evidenceId' AND e.case_id = c.id AND e.report_id = r.id)))) THEN
      RAISE EXCEPTION 'ADMIN_APPROVAL_TARGET_BINDING_INVALID';
    END IF;
  ELSIF NEW.action = 'sensitive_export' THEN
    IF NEW.target_type IS DISTINCT FROM 'export_scope'
      OR NEW.target_id IS DISTINCT FROM encode(sha256(convert_to(admin_canonical_jsonb(jsonb_build_object(
        'exportKind', NEW.payload->'exportKind', 'scope', NEW.payload->'scope')), 'UTF8')), 'hex')
      OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 2
      OR NOT (NEW.payload ?& ARRAY['exportKind','scope'])
      OR jsonb_typeof(NEW.payload->'exportKind') IS DISTINCT FROM 'string'
      OR NOT ((NEW.payload->>'exportKind' IN ('case_activity','safety_case')
          AND jsonb_typeof(NEW.payload->'scope') IS NOT DISTINCT FROM 'object'
          AND (SELECT count(*) FROM jsonb_object_keys(NEW.payload->'scope')) = 1
          AND NEW.payload->'scope' ? 'caseId'
          AND COALESCE((NEW.payload->'scope'->>'caseId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
        OR (NEW.payload->>'exportKind' = 'billing_ledger'
          AND jsonb_typeof(NEW.payload->'scope') IS NOT DISTINCT FROM 'object'
          AND (SELECT count(*) FROM jsonb_object_keys(NEW.payload->'scope')) = 1
          AND NEW.payload->'scope' ? 'subjectUserId'
          AND COALESCE((NEW.payload->'scope'->>'subjectUserId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))) THEN
      RAISE EXCEPTION 'ADMIN_APPROVAL_TARGET_BINDING_INVALID';
    END IF;
  ELSIF NEW.action = 'bulk_suspension' THEN
    IF NEW.target_type IS DISTINCT FROM 'user_batch'
      OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 2
      OR NOT (NEW.payload ?& ARRAY['targets','reasonCode'])
      OR jsonb_typeof(NEW.payload->'reasonCode') IS DISTINCT FROM 'string'
      OR length(btrim(NEW.payload->>'reasonCode')) NOT BETWEEN 1 AND 80
      OR admin_audit_text_is_sensitive(NEW.payload->>'reasonCode')
      OR jsonb_typeof(NEW.payload->'targets') IS DISTINCT FROM 'array'
      OR jsonb_array_length(NEW.payload->'targets') NOT BETWEEN 1 AND 100
      OR NEW.target_id IS DISTINCT FROM encode(sha256(convert_to(admin_canonical_jsonb(NEW.payload->'targets'), 'UTF8')), 'hex')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload->'targets') item
        GROUP BY item->>'userId' HAVING count(*) > 1)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload->'targets') item
        WHERE jsonb_typeof(item) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 4
          OR NOT (item ?& ARRAY['userId','caseId','expectedVersion','durationHours'])
          OR (item->>'userId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR (item->>'caseId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR jsonb_typeof(item->'expectedVersion') IS DISTINCT FROM 'number'
          OR COALESCE((item->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$', true)
          OR jsonb_typeof(item->'durationHours') IS DISTINCT FROM 'number'
          OR COALESCE((item->>'durationHours') !~ '^([1-9]|[1-9][0-9]{1,2}|[1-7][0-9]{3}|8[0-6][0-9]{2}|87[0-5][0-9]|8760)$', true))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload->'targets') item
        WHERE NOT EXISTS (SELECT 1 FROM moderation_cases c JOIN reports r ON r.id = c.report_id
          WHERE c.id = (item->>'caseId')::uuid AND r.target_user_id = (item->>'userId')::uuid)
        OR COALESCE((SELECT v.version FROM admin_user_action_versions v
          WHERE v.target_user_id = (item->>'userId')::uuid), 0) <> (item->>'expectedVersion')::integer) THEN
      RAISE EXCEPTION 'ADMIN_APPROVAL_TARGET_BINDING_INVALID';
    END IF;
  END IF;
  IF NEW.payload_hash IS DISTINCT FROM encode(sha256(convert_to(admin_canonical_jsonb(jsonb_build_object(
    'action', NEW.action, 'targetType', NEW.target_type, 'targetId', NEW.target_id,
    'payloadVersion', NEW.payload_version, 'payload', NEW.payload)), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_PAYLOAD_HASH_INVALID';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM admin_sessions s
    JOIN admin_role_assignments a ON a.id = s.role_assignment_id
    WHERE s.id = NEW.requester_admin_session_id
      AND s.user_id = NEW.requester_user_id AND a.user_id = NEW.requester_user_id
      AND a.active = 'active' AND a.revoked_at IS NULL
      AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
      AND s.mfa_verified_at IS NOT NULL
      AND s.mfa_verified_at <= CURRENT_TIMESTAMP
      AND s.mfa_verified_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
      AND admin_role_has_permission(a.role, NEW.request_permission)
  ) INTO valid_session;
  IF NOT valid_session OR NEW.expires_at <= CURRENT_TIMESTAMP
    OR NEW.expires_at > CURRENT_TIMESTAMP + INTERVAL '30 minutes' THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_REQUEST_FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_approval_requester_guard BEFORE INSERT ON admin_approval_requests
FOR EACH ROW EXECUTE FUNCTION admin_validate_approval_requester();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_validate_approval_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row admin_approval_requests%ROWTYPE; valid_session boolean;
BEGIN
  NEW.created_at := CURRENT_TIMESTAMP;
  SELECT * INTO request_row FROM admin_approval_requests WHERE id = NEW.request_id FOR UPDATE;
  IF NOT FOUND OR request_row.status <> 'pending' OR request_row.expires_at <= CURRENT_TIMESTAMP
    OR request_row.requester_user_id = NEW.approver_user_id
    OR request_row.approval_permission <> NEW.permission THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_DECISION_FORBIDDEN';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM admin_sessions s
    JOIN admin_role_assignments a ON a.id = s.role_assignment_id
    WHERE s.id = NEW.approver_admin_session_id
      AND s.user_id = NEW.approver_user_id AND a.user_id = NEW.approver_user_id
      AND a.active = 'active' AND a.revoked_at IS NULL
      AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
      AND s.mfa_verified_at IS NOT NULL
      AND s.mfa_verified_at <= CURRENT_TIMESTAMP
      AND s.mfa_verified_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
      AND admin_role_has_permission(a.role, request_row.approval_permission)
  ) INTO valid_session;
  IF NOT valid_session THEN RAISE EXCEPTION 'ADMIN_APPROVAL_DECISION_FORBIDDEN'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_approval_decision_guard BEFORE INSERT ON admin_approval_decisions
FOR EACH ROW EXECUTE FUNCTION admin_validate_approval_decision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_apply_approval_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE admin_approval_requests SET status = NEW.decision, updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.request_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'ADMIN_APPROVAL_DECISION_CONFLICT'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_approval_decision_apply AFTER INSERT ON admin_approval_decisions
FOR EACH ROW EXECUTE FUNCTION admin_apply_approval_decision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_validate_export_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row admin_approval_requests%ROWTYPE;
BEGIN
  SELECT * INTO request_row FROM admin_approval_requests WHERE id = NEW.approval_request_id;
  IF NOT FOUND OR request_row.action <> 'sensitive_export' OR request_row.status <> 'executing'
    OR NOT EXISTS (SELECT 1 FROM admin_approval_decisions d
      WHERE d.request_id = request_row.id AND d.decision = 'approved')
    OR NEW.requested_by_user_id IS DISTINCT FROM request_row.requester_user_id
    OR NEW.export_kind IS DISTINCT FROM request_row.payload->>'exportKind'
    OR admin_canonical_jsonb(NEW.scope) IS DISTINCT FROM admin_canonical_jsonb(request_row.payload->'scope')
    OR NEW.payload_hash IS DISTINCT FROM request_row.payload_hash
    OR NEW.status IS DISTINCT FROM 'queued' OR NEW.attempts <> 0
    OR NEW.object_key IS NOT NULL OR NEW.artifact_version IS NOT NULL OR NEW.storage_version_id IS NOT NULL
    OR NEW.content_hash IS NOT NULL OR NEW.size_bytes IS NOT NULL OR NEW.expires_at IS NOT NULL
    OR NEW.lease_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.last_error_code IS NOT NULL
    OR NEW.manual_review_at IS NOT NULL THEN
    RAISE EXCEPTION 'ADMIN_EXPORT_JOB_INSERT_FORBIDDEN';
  END IF;
  NEW.created_at := CURRENT_TIMESTAMP;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_export_jobs_insert_guard BEFORE INSERT ON admin_export_jobs
FOR EACH ROW EXECUTE FUNCTION admin_validate_export_job_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_outbox_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row admin_approval_requests%ROWTYPE;
BEGIN
  SELECT * INTO request_row FROM admin_approval_requests WHERE id = NEW.approval_request_id;
  IF NOT FOUND OR NEW.status IS DISTINCT FROM 'pending' OR NEW.attempts IS DISTINCT FROM 0
    OR NEW.lease_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.last_error_code IS NOT NULL
    OR NEW.delivered_at IS NOT NULL OR NEW.manual_review_at IS NOT NULL
    OR NEW.event_type !~ '^admin\.[a-z0-9_.]+$'
    OR NEW.aggregate_type IS DISTINCT FROM request_row.target_type
    OR NEW.aggregate_id IS DISTINCT FROM request_row.target_id
    OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
    OR NEW.payload->>'approvalRequestId' IS DISTINCT FROM NEW.approval_request_id::text
    OR NEW.payload->>'targetType' IS DISTINCT FROM NEW.aggregate_type
    OR NEW.payload->>'targetId' IS DISTINCT FROM NEW.aggregate_id
    OR NEW.payload->>'requestId' IS DISTINCT FROM NEW.request_id::text
    OR NEW.payload->>'ipHash' IS DISTINCT FROM NEW.ip_hash THEN
    RAISE EXCEPTION 'ADMIN_OUTBOX_INSERT_FORBIDDEN';
  END IF;
  NEW.created_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_outbox_insert_controlled BEFORE INSERT ON admin_outbox_events
FOR EACH ROW EXECUTE FUNCTION admin_outbox_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_outbox_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.approval_request_id,OLD.event_type,OLD.aggregate_type,OLD.aggregate_id,
      OLD.request_id,OLD.ip_hash,OLD.payload,OLD.created_at)
    IS DISTINCT FROM (NEW.approval_request_id,NEW.event_type,NEW.aggregate_type,NEW.aggregate_id,
      NEW.request_id,NEW.ip_hash,NEW.payload,NEW.created_at) THEN
    RAISE EXCEPTION 'ADMIN_OUTBOX_FACT_IMMUTABLE';
  END IF;
  IF OLD.status IN ('delivered','failed') THEN RAISE EXCEPTION 'ADMIN_OUTBOX_TERMINAL'; END IF;
  IF OLD.status IN ('pending','retrying') AND NEW.status = 'processing' THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts + 1 OR NEW.lease_id IS NULL
      OR NEW.lease_expires_at <= statement_timestamp() OR NEW.last_error_code IS NOT NULL
      OR NEW.delivered_at IS NOT NULL OR NEW.manual_review_at IS NOT NULL THEN
      RAISE EXCEPTION 'ADMIN_OUTBOX_CLAIM_INVALID';
    END IF;
  ELSIF OLD.status = 'processing' AND NEW.status = 'processing' THEN
    IF OLD.lease_expires_at > statement_timestamp() OR NEW.lease_id IS NULL
      OR NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id OR NEW.lease_expires_at <= statement_timestamp()
      OR NEW.attempts IS DISTINCT FROM OLD.attempts + 1 THEN
      RAISE EXCEPTION 'ADMIN_OUTBOX_RECOVERY_INVALID';
    END IF;
  ELSIF OLD.status = 'processing' AND NEW.status = 'failed'
    AND OLD.lease_expires_at <= statement_timestamp() THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts + 1 OR NEW.lease_id IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL OR NEW.delivered_at IS NOT NULL
      OR NEW.last_error_code IS DISTINCT FROM 'ADMIN_OUTBOX_LEASE_RECOVERY_EXHAUSTED'
      OR NEW.manual_review_at IS NULL THEN
      RAISE EXCEPTION 'ADMIN_OUTBOX_RECOVERY_FAILURE_INVALID';
    END IF;
  ELSIF OLD.status = 'processing' AND NEW.status IN ('delivered','retrying','failed') THEN
    IF OLD.lease_expires_at <= statement_timestamp() OR NEW.lease_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
      OR (NEW.status = 'delivered' AND (NEW.delivered_at IS NULL OR NEW.last_error_code IS NOT NULL))
      OR (NEW.status = 'retrying' AND (NEW.last_error_code IS NULL OR NEW.available_at <= statement_timestamp()))
      OR (NEW.status = 'failed' AND (NEW.last_error_code IS NULL OR NEW.manual_review_at IS NULL)) THEN
      RAISE EXCEPTION 'ADMIN_OUTBOX_FINALIZE_INVALID';
    END IF;
  ELSE RAISE EXCEPTION 'ADMIN_OUTBOX_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_outbox_updates_controlled BEFORE UPDATE OR DELETE ON admin_outbox_events
FOR EACH ROW EXECUTE FUNCTION admin_outbox_transition_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_reject_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ADMIN_APPEND_ONLY'; END $$;
--> statement-breakpoint
CREATE TRIGGER admin_audit_logs_append_only BEFORE UPDATE OR DELETE ON admin_audit_logs
FOR EACH ROW EXECUTE FUNCTION admin_reject_append_only();
--> statement-breakpoint
CREATE TRIGGER admin_approval_decisions_append_only BEFORE UPDATE OR DELETE ON admin_approval_decisions
FOR EACH ROW EXECUTE FUNCTION admin_reject_append_only();
--> statement-breakpoint
CREATE TRIGGER admin_config_changes_append_only BEFORE UPDATE OR DELETE ON admin_config_changes
FOR EACH ROW EXECUTE FUNCTION admin_reject_append_only();
--> statement-breakpoint
CREATE TRIGGER admin_action_idempotency_append_only BEFORE UPDATE OR DELETE ON admin_action_idempotency
FOR EACH ROW EXECUTE FUNCTION admin_reject_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_export_job_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ADMIN_EXPORT_JOB_IMMUTABLE'; END IF;
  IF (OLD.approval_request_id,OLD.requested_by_user_id,OLD.export_kind,OLD.scope,OLD.payload_hash,OLD.created_at)
    IS DISTINCT FROM
    (NEW.approval_request_id,NEW.requested_by_user_id,NEW.export_kind,NEW.scope,NEW.payload_hash,NEW.created_at)
    OR NOT ((OLD.status = 'queued' AND NEW.status IN ('processing','failed','manual_review'))
      OR (OLD.status = 'processing' AND NEW.status IN ('queued','ready','failed','manual_review'))
      OR (OLD.status = 'ready' AND NEW.status IN ('purging','manual_review'))
      OR (OLD.status = 'purging' AND NEW.status IN ('ready','purged','manual_review'))
      OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'ADMIN_EXPORT_JOB_IMMUTABLE';
  END IF;
  IF NOT (OLD.status = 'processing' AND NEW.status = 'ready')
    AND (OLD.object_key,OLD.artifact_version,OLD.storage_version_id,OLD.content_hash,
      OLD.size_bytes,OLD.expires_at) IS DISTINCT FROM
    (NEW.object_key,NEW.artifact_version,NEW.storage_version_id,NEW.content_hash,NEW.size_bytes,NEW.expires_at) THEN
    RAISE EXCEPTION 'ADMIN_EXPORT_ARTIFACT_IMMUTABLE';
  END IF;
  IF OLD.status IN ('purged','failed','manual_review')
    AND ROW(OLD.*) IS DISTINCT FROM ROW(NEW.*) THEN
    RAISE EXCEPTION 'ADMIN_EXPORT_JOB_TERMINAL';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_export_jobs_controlled BEFORE UPDATE OR DELETE ON admin_export_jobs
FOR EACH ROW EXECUTE FUNCTION admin_export_job_transition_guard();
--> statement-breakpoint
CREATE TRIGGER admin_safety_access_grants_immutable BEFORE UPDATE OR DELETE ON admin_safety_access_grants
FOR EACH ROW EXECUTE FUNCTION admin_reject_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_approval_request_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.requester_user_id, OLD.requester_admin_session_id, OLD.request_id, OLD.ip_hash, OLD.action,
      OLD.request_permission, OLD.approval_permission, OLD.target_type, OLD.target_id, OLD.payload_version,
      OLD.payload, OLD.payload_hash, OLD.reason, OLD.expires_at, OLD.created_at)
    IS DISTINCT FROM
     (NEW.requester_user_id, NEW.requester_admin_session_id, NEW.request_id, NEW.ip_hash, NEW.action,
      NEW.request_permission, NEW.approval_permission, NEW.target_type, NEW.target_id, NEW.payload_version,
      NEW.payload, NEW.payload_hash, NEW.reason, NEW.expires_at, NEW.created_at) THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_IMMUTABLE';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved','rejected','expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('executing','expired'))
    OR (OLD.status = 'executing' AND NEW.status IN ('executed','approved','failed','expired'))
    OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_INVALID_TRANSITION';
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('approved','rejected')
    AND NOT EXISTS (SELECT 1 FROM admin_approval_decisions d
      WHERE d.request_id = OLD.id AND d.decision = NEW.status) THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_DECISION_REQUIRED';
  END IF;
  IF OLD.status IN ('rejected','executed','expired') AND ROW(OLD.*) IS DISTINCT FROM ROW(NEW.*) THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_TERMINAL';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_approval_request_transition BEFORE UPDATE ON admin_approval_requests
FOR EACH ROW EXECUTE FUNCTION admin_approval_request_transition_guard();
--> statement-breakpoint
CREATE TRIGGER admin_approval_requests_no_delete BEFORE DELETE ON admin_approval_requests
FOR EACH ROW EXECUTE FUNCTION admin_reject_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_safety_grant_relation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval admin_approval_requests%ROWTYPE;
BEGIN
  SELECT * INTO approval FROM admin_approval_requests WHERE id = NEW.approval_request_id;
  IF NOT FOUND OR approval.action IS DISTINCT FROM 'safety_evidence_access' OR approval.status NOT IN ('executing','executed')
    OR NOT EXISTS (SELECT 1 FROM admin_approval_decisions d
      WHERE d.request_id IS NOT DISTINCT FROM approval.id AND d.decision IS NOT DISTINCT FROM 'approved')
    OR num_nonnulls(NEW.evidence_id, NEW.message_id) IS DISTINCT FROM 1
    OR (approval.payload ? 'evidenceId') IS DISTINCT FROM (NEW.evidence_id IS NOT NULL)
    OR (approval.payload ? 'messageId') IS DISTINCT FROM (NEW.message_id IS NOT NULL)
    OR approval.requester_user_id IS DISTINCT FROM NEW.actor_user_id
    OR approval.payload->>'actorUserId' IS DISTINCT FROM NEW.actor_user_id::text
    OR approval.payload->>'caseId' IS DISTINCT FROM NEW.case_id::text
    OR approval.payload->>'reportId' IS DISTINCT FROM NEW.report_id::text
    OR NEW.expires_at <= CURRENT_TIMESTAMP OR NEW.expires_at > CURRENT_TIMESTAMP + INTERVAL '30 minutes'
    OR NOT EXISTS (SELECT 1 FROM moderation_cases c WHERE c.id IS NOT DISTINCT FROM NEW.case_id
      AND c.report_id IS NOT DISTINCT FROM NEW.report_id)
    OR (NEW.evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM moderation_evidence e WHERE e.id IS NOT DISTINCT FROM NEW.evidence_id
        AND e.case_id IS NOT DISTINCT FROM NEW.case_id AND e.report_id IS NOT DISTINCT FROM NEW.report_id
    ))
    OR (NEW.message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM reports r WHERE r.id IS NOT DISTINCT FROM NEW.report_id
        AND r.message_id IS NOT DISTINCT FROM NEW.message_id
    )) THEN RAISE EXCEPTION 'ADMIN_SAFETY_GRANT_RELATION_INVALID';
  END IF;
  IF (NEW.evidence_id IS NOT NULL AND approval.payload->>'evidenceId' IS DISTINCT FROM NEW.evidence_id::text)
    OR (NEW.message_id IS NOT NULL AND approval.payload->>'messageId' IS DISTINCT FROM NEW.message_id::text) THEN
    RAISE EXCEPTION 'ADMIN_SAFETY_GRANT_TARGET_INVALID';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_safety_grant_relation BEFORE INSERT ON admin_safety_access_grants
FOR EACH ROW EXECUTE FUNCTION admin_safety_grant_relation_guard();
