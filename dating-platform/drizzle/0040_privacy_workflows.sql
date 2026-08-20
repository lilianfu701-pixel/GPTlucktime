CREATE TABLE "account_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"status" text DEFAULT 'cooling_off' NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"original_profile_discoverable" boolean DEFAULT false NOT NULL,
	"cancellation_token_hash" varchar(64) NOT NULL,
	"cancellation_token_expires_at" timestamp with time zone NOT NULL,
	"cancellation_token_used_at" timestamp with time zone,
	"cancellation_token_revoked_at" timestamp with time zone,
	"preserve_held_records" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"manual_review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_requests_owner_idempotency_unique" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "account_deletion_requests_cancellation_token_unique" UNIQUE("cancellation_token_hash"),
	CONSTRAINT "account_deletion_requests_status_check" CHECK ("account_deletion_requests"."status" IN ('cooling_off', 'processing', 'canceled', 'completed', 'manual_review')),
	CONSTRAINT "account_deletion_requests_attempts_check" CHECK ("account_deletion_requests"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "account_deletion_requests_cooling_window_check" CHECK ("account_deletion_requests"."execute_at" >= "account_deletion_requests"."created_at" + interval '30 days'),
	CONSTRAINT "account_deletion_requests_available_at_check" CHECK ("account_deletion_requests"."available_at" >= "account_deletion_requests"."execute_at"),
	CONSTRAINT "account_deletion_requests_cancellation_token_check" CHECK (
    "account_deletion_requests"."cancellation_token_hash" ~ '^[a-f0-9]{64}$'
    AND "account_deletion_requests"."cancellation_token_expires_at" > "account_deletion_requests"."created_at"
    AND "account_deletion_requests"."cancellation_token_expires_at" <= "account_deletion_requests"."execute_at"
    AND NOT ("account_deletion_requests"."cancellation_token_used_at" IS NOT NULL AND "account_deletion_requests"."cancellation_token_revoked_at" IS NOT NULL)),
	CONSTRAINT "account_deletion_requests_lease_shape_check" CHECK (
    ("account_deletion_requests"."status" = 'processing' AND "account_deletion_requests"."lease_id" IS NOT NULL AND "account_deletion_requests"."lease_expires_at" IS NOT NULL)
    OR ("account_deletion_requests"."status" <> 'processing' AND "account_deletion_requests"."lease_id" IS NULL AND "account_deletion_requests"."lease_expires_at" IS NULL)),
	CONSTRAINT "account_deletion_requests_terminal_shape_check" CHECK (
    ("account_deletion_requests"."status" = 'canceled' AND "account_deletion_requests"."canceled_at" IS NOT NULL)
    OR ("account_deletion_requests"."status" = 'completed' AND "account_deletion_requests"."completed_at" IS NOT NULL)
    OR "account_deletion_requests"."status" IN ('cooling_off', 'processing', 'manual_review'))
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"dedupe_key" varchar(180) NOT NULL,
	"category" text NOT NULL,
	"template_key" varchar(160) NOT NULL,
	"locale" varchar(10) NOT NULL,
	"channels" text[] NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_encrypted" text,
	"encryption_key_id" varchar(120),
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"manual_review_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_dedupe_unique" UNIQUE("user_id","dedupe_key"),
	CONSTRAINT "notification_outbox_category_check" CHECK ("notification_outbox"."category" IN ('security', 'transactional', 'marketing')),
	CONSTRAINT "notification_outbox_locale_check" CHECK ("notification_outbox"."locale" IN ('en', 'zh-CN')),
	CONSTRAINT "notification_outbox_status_check" CHECK ("notification_outbox"."status" IN ('pending', 'processing', 'sent', 'suppressed', 'manual_review')),
	CONSTRAINT "notification_outbox_attempts_check" CHECK ("notification_outbox"."attempts" BETWEEN 0 AND "notification_outbox"."max_attempts" AND "notification_outbox"."max_attempts" BETWEEN 1 AND 10),
	CONSTRAINT "notification_outbox_lease_shape_check" CHECK (
    ("notification_outbox"."status" = 'processing' AND "notification_outbox"."lease_id" IS NOT NULL AND "notification_outbox"."lease_expires_at" IS NOT NULL)
    OR ("notification_outbox"."status" <> 'processing' AND "notification_outbox"."lease_id" IS NULL AND "notification_outbox"."lease_expires_at" IS NULL)),
	CONSTRAINT "notification_outbox_payload_encryption_check" CHECK (
    ("notification_outbox"."payload_encrypted" IS NULL AND "notification_outbox"."encryption_key_id" IS NULL)
    OR ("notification_outbox"."payload_encrypted" IS NOT NULL AND "notification_outbox"."encryption_key_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"time_zone" varchar(100) DEFAULT 'UTC' NOT NULL,
	"marketing_enabled" boolean DEFAULT false NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"in_app_enabled" boolean DEFAULT true NOT NULL,
	"quiet_start_hour" integer,
	"quiet_end_hour" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_locale_check" CHECK ("notification_preferences"."locale" IN ('en', 'zh-CN')),
	CONSTRAINT "notification_preferences_quiet_hours_check" CHECK (
    ("notification_preferences"."quiet_start_hour" IS NULL AND "notification_preferences"."quiet_end_hour" IS NULL)
    OR ("notification_preferences"."quiet_start_hour" BETWEEN 0 AND 23 AND "notification_preferences"."quiet_end_hour" BETWEEN 0 AND 23
      AND "notification_preferences"."quiet_start_hour" <> "notification_preferences"."quiet_end_hour"))
);
--> statement-breakpoint
CREATE TABLE "notification_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"outbox_id" uuid NOT NULL,
	"provider_idempotency_key" varchar(180) NOT NULL,
	"template_key" varchar(160) NOT NULL,
	"locale" varchar(10) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notification_inbox_provider_idempotency_unique" UNIQUE("provider_idempotency_key"),
	CONSTRAINT "notification_inbox_locale_check" CHECK ("notification_inbox"."locale" IN ('en', 'zh-CN'))
);
--> statement-breakpoint
CREATE TABLE "privacy_export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"object_key" text,
	"prepared_artifact_encrypted" text,
	"prepared_integrity_sha256" varchar(64),
	"object_version" varchar(255),
	"integrity_sha256" varchar(64),
	"encryption_key_id" varchar(120),
	"schema_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"download_token_hash" varchar(64),
	"download_token_expires_at" timestamp with time zone,
	"download_token_used_at" timestamp with time zone,
	"download_token_revoked_at" timestamp with time zone,
	"download_lease_id" uuid,
	"download_lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"manual_review_at" timestamp with time zone,
	"cleanup_status" text DEFAULT 'pending' NOT NULL,
	"cleanup_attempts" integer DEFAULT 0 NOT NULL,
	"cleanup_available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleanup_lease_id" uuid,
	"cleanup_lease_expires_at" timestamp with time zone,
	"cleanup_last_error_code" varchar(80),
	"cleanup_manual_review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_export_jobs_owner_idempotency_unique" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "privacy_export_jobs_object_version_unique" UNIQUE("object_key","object_version"),
	CONSTRAINT "privacy_export_jobs_download_token_unique" UNIQUE("download_token_hash"),
	CONSTRAINT "privacy_export_jobs_status_check" CHECK ("privacy_export_jobs"."status" IN ('pending', 'processing', 'ready', 'failed', 'expired', 'manual_review')),
	CONSTRAINT "privacy_export_jobs_attempts_check" CHECK ("privacy_export_jobs"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "privacy_export_jobs_cleanup_attempts_check" CHECK ("privacy_export_jobs"."cleanup_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "privacy_export_jobs_cleanup_status_check" CHECK ("privacy_export_jobs"."cleanup_status" IN ('pending', 'processing', 'completed', 'manual_review')),
	CONSTRAINT "privacy_export_jobs_lease_shape_check" CHECK (
    ("privacy_export_jobs"."status" = 'processing' AND "privacy_export_jobs"."lease_id" IS NOT NULL AND "privacy_export_jobs"."lease_expires_at" IS NOT NULL)
    OR ("privacy_export_jobs"."status" <> 'processing' AND "privacy_export_jobs"."lease_id" IS NULL AND "privacy_export_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "privacy_export_jobs_cleanup_lease_shape_check" CHECK (
    ("privacy_export_jobs"."cleanup_status" = 'processing' AND "privacy_export_jobs"."cleanup_lease_id" IS NOT NULL AND "privacy_export_jobs"."cleanup_lease_expires_at" IS NOT NULL)
    OR ("privacy_export_jobs"."cleanup_status" <> 'processing' AND "privacy_export_jobs"."cleanup_lease_id" IS NULL AND "privacy_export_jobs"."cleanup_lease_expires_at" IS NULL)),
	CONSTRAINT "privacy_export_jobs_integrity_check" CHECK ("privacy_export_jobs"."integrity_sha256" IS NULL OR "privacy_export_jobs"."integrity_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "privacy_export_jobs_prepared_artifact_check" CHECK (
    ("privacy_export_jobs"."prepared_artifact_encrypted" IS NULL AND "privacy_export_jobs"."prepared_integrity_sha256" IS NULL)
    OR ("privacy_export_jobs"."prepared_artifact_encrypted" IS NOT NULL AND "privacy_export_jobs"."prepared_integrity_sha256" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "privacy_export_jobs_download_token_check" CHECK (
    ("privacy_export_jobs"."download_token_hash" IS NULL AND "privacy_export_jobs"."download_token_expires_at" IS NULL)
    OR ("privacy_export_jobs"."download_token_hash" ~ '^[a-f0-9]{64}$' AND "privacy_export_jobs"."download_token_expires_at" IS NOT NULL
      AND NOT ("privacy_export_jobs"."download_token_used_at" IS NOT NULL AND "privacy_export_jobs"."download_token_revoked_at" IS NOT NULL))),
	CONSTRAINT "privacy_export_jobs_download_lease_shape_check" CHECK (
    ("privacy_export_jobs"."download_lease_id" IS NULL AND "privacy_export_jobs"."download_lease_expires_at" IS NULL)
    OR ("privacy_export_jobs"."download_lease_id" IS NOT NULL AND "privacy_export_jobs"."download_lease_expires_at" IS NOT NULL
      AND "privacy_export_jobs"."status" = 'ready' AND "privacy_export_jobs"."download_token_hash" IS NOT NULL
      AND "privacy_export_jobs"."download_token_used_at" IS NULL AND "privacy_export_jobs"."download_token_revoked_at" IS NULL)),
	CONSTRAINT "privacy_export_jobs_ready_shape_check" CHECK ("privacy_export_jobs"."status" <> 'ready' OR (
    "privacy_export_jobs"."object_key" IS NOT NULL AND "privacy_export_jobs"."object_version" IS NOT NULL AND "privacy_export_jobs"."integrity_sha256" IS NOT NULL
    AND "privacy_export_jobs"."encryption_key_id" IS NOT NULL AND "privacy_export_jobs"."expires_at" IS NOT NULL AND "privacy_export_jobs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "privacy_retention_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deletion_request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"record_type" varchar(80) NOT NULL,
	"record_id" varchar(255) NOT NULL,
	"legal_basis" varchar(80) NOT NULL,
	"restricted_locator" jsonb NOT NULL,
	"preserve_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_retention_ledger_record_unique" UNIQUE("deletion_request_id","record_type","record_id"),
	CONSTRAINT "privacy_retention_ledger_basis_check" CHECK ("privacy_retention_ledger"."legal_basis" IN ('legal_hold', 'moderation', 'billing_ledger'))
);
--> statement-breakpoint
CREATE TABLE "privacy_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"deletion_request_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_audit_events_request_type_unique" UNIQUE("deletion_request_id","event_type"),
	CONSTRAINT "privacy_audit_events_type_check" CHECK ("privacy_audit_events"."event_type" IN ('deletion_requested','deletion_canceled','deletion_completed'))
);
--> statement-breakpoint
CREATE TABLE "privacy_workflow_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"deletion_request_id" uuid,
	"export_job_id" uuid,
	"event_type" varchar(80) NOT NULL,
	"dedupe_key" varchar(180) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"manual_review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_workflow_outbox_dedupe_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "privacy_workflow_outbox_type_check" CHECK ("privacy_workflow_outbox"."event_type" IN ('export_requested', 'export_ready', 'deletion_requested', 'renewal_cancel_requested', 'deletion_canceled', 'deletion_completed')),
	CONSTRAINT "privacy_workflow_outbox_status_check" CHECK ("privacy_workflow_outbox"."status" IN ('pending', 'processing', 'done', 'manual_review')),
	CONSTRAINT "privacy_workflow_outbox_attempts_check" CHECK ("privacy_workflow_outbox"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "privacy_workflow_outbox_lease_shape_check" CHECK (
    ("privacy_workflow_outbox"."status" = 'processing' AND "privacy_workflow_outbox"."lease_id" IS NOT NULL AND "privacy_workflow_outbox"."lease_expires_at" IS NOT NULL)
    OR ("privacy_workflow_outbox"."status" <> 'processing' AND "privacy_workflow_outbox"."lease_id" IS NULL AND "privacy_workflow_outbox"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_outbox_id_notification_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_export_jobs" ADD CONSTRAINT "privacy_export_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_retention_ledger" ADD CONSTRAINT "privacy_retention_ledger_deletion_request_id_account_deletion_requests_id_fk" FOREIGN KEY ("deletion_request_id") REFERENCES "public"."account_deletion_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_retention_ledger" ADD CONSTRAINT "privacy_retention_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_audit_events" ADD CONSTRAINT "privacy_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_audit_events" ADD CONSTRAINT "privacy_audit_events_deletion_request_id_account_deletion_requests_id_fk" FOREIGN KEY ("deletion_request_id") REFERENCES "public"."account_deletion_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_workflow_outbox" ADD CONSTRAINT "privacy_workflow_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_workflow_outbox" ADD CONSTRAINT "privacy_workflow_outbox_deletion_request_id_account_deletion_requests_id_fk" FOREIGN KEY ("deletion_request_id") REFERENCES "public"."account_deletion_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_workflow_outbox" ADD CONSTRAINT "privacy_workflow_outbox_export_job_id_privacy_export_jobs_id_fk" FOREIGN KEY ("export_job_id") REFERENCES "public"."privacy_export_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_requests_active_owner_unique" ON "account_deletion_requests" USING btree ("user_id") WHERE "account_deletion_requests"."status" IN ('cooling_off', 'processing');--> statement-breakpoint
CREATE INDEX "account_deletion_requests_claim_idx" ON "account_deletion_requests" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "notification_outbox_claim_idx" ON "notification_outbox" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "notification_inbox_owner_created_idx" ON "notification_inbox" USING btree ("user_id","delivered_at");--> statement-breakpoint
CREATE INDEX "privacy_export_jobs_claim_idx" ON "privacy_export_jobs" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "privacy_export_jobs_expiry_idx" ON "privacy_export_jobs" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "privacy_retention_ledger_owner_idx" ON "privacy_retention_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_audit_events_owner_idx" ON "privacy_audit_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "privacy_workflow_outbox_claim_idx" ON "privacy_workflow_outbox" USING btree ("status","available_at","lease_expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION privacy_prepare_deletion_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'cooling_off' OR NEW.attempts <> 0
    OR NEW.available_at IS DISTINCT FROM NEW.execute_at
    OR NEW.lease_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR NEW.canceled_at IS NOT NULL OR NEW.completed_at IS NOT NULL
    OR NEW.last_error_code IS NOT NULL OR NEW.manual_review_at IS NOT NULL
    OR NEW.cancellation_token_used_at IS NOT NULL OR NEW.cancellation_token_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
  END IF;
  NEW.cancellation_token_hash := COALESCE(NEW.cancellation_token_hash,
    encode(sha256(gen_random_uuid()::text::bytea), 'hex'));
  IF NEW.cancellation_token_hash !~ '^[a-f0-9]{64}$'
    OR (NEW.cancellation_token_expires_at IS NOT NULL
      AND NEW.cancellation_token_expires_at IS DISTINCT FROM NEW.execute_at) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_INVALID_CANCELLATION_CREDENTIAL' USING ERRCODE = '23514';
  END IF;
  NEW.cancellation_token_expires_at := NEW.execute_at;
  NEW.original_profile_discoverable := COALESCE((SELECT discoverable FROM profiles WHERE user_id = NEW.user_id), false);
  IF EXISTS (
    SELECT 1 FROM moderation_media_holds
    WHERE subject_user_id = NEW.user_id AND active = true
      AND (preserve_until IS NULL OR preserve_until > now())
  ) THEN
    NEW.preserve_held_records := true;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_deletion_prepare_before_insert
BEFORE INSERT ON account_deletion_requests
FOR EACH ROW EXECUTE FUNCTION privacy_prepare_deletion_request();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION privacy_apply_deletion_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.user_id;
  UPDATE profiles SET discoverable = false, updated_at = now() WHERE user_id = NEW.user_id;
  INSERT INTO privacy_workflow_outbox (user_id, deletion_request_id, event_type, dedupe_key)
  VALUES
    (NEW.user_id, NEW.id, 'deletion_requested', 'deletion-requested:' || NEW.id::text),
    (NEW.user_id, NEW.id, 'renewal_cancel_requested', 'renewal-cancel:' || NEW.id::text)
  ON CONFLICT (dedupe_key) DO NOTHING;
  INSERT INTO privacy_audit_events (user_id, deletion_request_id, event_type, details)
  VALUES (NEW.user_id, NEW.id, 'deletion_requested', jsonb_build_object('executeAt', NEW.execute_at))
  ON CONFLICT (deletion_request_id, event_type) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_deletion_apply_after_insert
AFTER INSERT ON account_deletion_requests
FOR EACH ROW EXECUTE FUNCTION privacy_apply_deletion_request();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION privacy_enforce_deletion_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('canceled','completed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'cooling_off' AND NEW.status = 'processing'
    AND (statement_timestamp() < OLD.execute_at OR statement_timestamp() < OLD.available_at) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_NOT_DUE' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'cooling_off' AND NEW.status IN ('processing','canceled'))
    OR (OLD.status = 'processing' AND NEW.status IN ('cooling_off','completed','manual_review'))
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_deletion_transition_guard
BEFORE UPDATE ON account_deletion_requests
FOR EACH ROW EXECUTE FUNCTION privacy_enforce_deletion_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION privacy_block_session_during_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM account_deletion_requests
    WHERE user_id = NEW.user_id AND status IN ('cooling_off', 'processing')
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_IN_PROGRESS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sessions_block_during_deletion
BEFORE INSERT OR UPDATE OF user_id ON sessions
FOR EACH ROW EXECUTE FUNCTION privacy_block_session_during_deletion();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION privacy_block_discoverable_during_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.discoverable = true AND EXISTS (
    SELECT 1 FROM account_deletion_requests
    WHERE user_id = NEW.user_id AND status IN ('cooling_off', 'processing')
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_IN_PROGRESS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER profiles_block_discovery_during_deletion
BEFORE INSERT OR UPDATE OF discoverable, user_id ON profiles
FOR EACH ROW EXECUTE FUNCTION privacy_block_discoverable_during_deletion();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION privacy_reject_retention_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PRIVACY_RETENTION_LEDGER_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER privacy_retention_ledger_append_only
BEFORE UPDATE OR DELETE ON privacy_retention_ledger
FOR EACH ROW EXECUTE FUNCTION privacy_reject_retention_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER privacy_audit_events_append_only
BEFORE UPDATE OR DELETE ON privacy_audit_events
FOR EACH ROW EXECUTE FUNCTION privacy_reject_retention_ledger_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION privacy_enforce_export_download_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.download_lease_id IS NOT NULL OR NEW.download_lease_expires_at IS NOT NULL
      OR NEW.download_token_used_at IS NOT NULL THEN
      RAISE EXCEPTION 'PRIVACY_EXPORT_DOWNLOAD_LEASE_STALE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.download_token_used_at IS NOT NULL
    AND NEW.download_token_used_at IS DISTINCT FROM OLD.download_token_used_at THEN
    RAISE EXCEPTION 'PRIVACY_EXPORT_DOWNLOAD_ALREADY_USED' USING ERRCODE = '23514';
  END IF;
  IF NEW.download_lease_id IS DISTINCT FROM OLD.download_lease_id AND NEW.download_lease_id IS NOT NULL THEN
    IF OLD.download_token_used_at IS NOT NULL OR OLD.download_token_revoked_at IS NOT NULL
      OR NEW.status <> 'ready' OR NEW.download_lease_expires_at IS NULL
      OR (OLD.download_lease_id IS NOT NULL AND OLD.download_lease_expires_at > statement_timestamp()) THEN
      RAISE EXCEPTION 'PRIVACY_EXPORT_DOWNLOAD_LEASE_STALE' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.download_token_used_at IS NULL AND NEW.download_token_used_at IS NOT NULL THEN
    IF OLD.download_lease_id IS NULL OR OLD.download_lease_expires_at <= statement_timestamp()
      OR NEW.download_lease_id IS NOT NULL OR NEW.download_lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'PRIVACY_EXPORT_DOWNLOAD_LEASE_STALE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER privacy_export_download_reservation_guard
BEFORE INSERT OR UPDATE OF status, download_token_used_at, download_token_revoked_at,
  download_lease_id, download_lease_expires_at ON privacy_export_jobs
FOR EACH ROW EXECUTE FUNCTION privacy_enforce_export_download_reservation();
--> statement-breakpoint
ALTER TABLE "auth_notification_deliveries" DROP CONSTRAINT "auth_notification_kind_check";--> statement-breakpoint
ALTER TABLE "auth_notification_deliveries" ADD CONSTRAINT "auth_notification_kind_check" CHECK ("kind" in ('email_verification', 'password_reset', 'sms_otp', 'deletion_cancellation', 'privacy_export_download'));--> statement-breakpoint
