CREATE TABLE "appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appellant_user_id" uuid NOT NULL,
	"original_case_id" uuid NOT NULL,
	"review_case_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"final_decision_summary" text,
	"decided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "appeals_original_case_unique" UNIQUE("original_case_id"),
	CONSTRAINT "appeals_review_case_unique" UNIQUE("review_case_id"),
	CONSTRAINT "appeals_status_check" CHECK ("appeals"."status" IN ('submitted', 'under_review', 'upheld', 'overturned', 'modified')),
	CONSTRAINT "appeals_statement_length_check" CHECK (char_length("appeals"."statement") BETWEEN 1 AND 2000),
	CONSTRAINT "appeals_distinct_cases_check" CHECK ("appeals"."original_case_id" <> "appeals"."review_case_id"),
	CONSTRAINT "appeals_final_check" CHECK (
    ("appeals"."status" IN ('upheld', 'overturned', 'modified') AND "appeals"."final_decision_summary" IS NOT NULL AND "appeals"."decided_by_user_id" IS NOT NULL AND "appeals"."finalized_at" IS NOT NULL)
    OR ("appeals"."status" NOT IN ('upheld', 'overturned', 'modified') AND "appeals"."finalized_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "legal_workflow_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"jurisdiction_code" varchar(8) NOT NULL,
	"workflow_code" varchar(80) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "legal_workflow_tasks_dedupe_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "legal_workflow_tasks_status_check" CHECK ("legal_workflow_tasks"."status" IN ('pending', 'in_progress', 'completed', 'not_required')),
	CONSTRAINT "legal_workflow_tasks_jurisdiction_check" CHECK (char_length("legal_workflow_tasks"."jurisdiction_code") BETWEEN 2 AND 8)
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"reason_code" varchar(80) NOT NULL,
	"evidence_summary" text NOT NULL,
	"operator_user_id" uuid NOT NULL,
	"expiry_policy" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_actions_type_check" CHECK ("moderation_actions"."action_type" IN ('warn', 'temporary_restriction', 'suspend', 'ban', 'quarantine_content', 'restore')),
	CONSTRAINT "moderation_actions_expiry_policy_check" CHECK ("moderation_actions"."expiry_policy" IN ('fixed', 'indefinite_review')),
	CONSTRAINT "moderation_actions_reason_length_check" CHECK (char_length("moderation_actions"."reason_code") BETWEEN 1 AND 80),
	CONSTRAINT "moderation_actions_evidence_length_check" CHECK (char_length("moderation_actions"."evidence_summary") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "moderation_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_audit_actor_role_check" CHECK ("moderation_audit_events"."actor_role" IN ('system', 'case_worker', 'safety_specialist', 'appeal_reviewer', 'legal_reviewer'))
);
--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"kind" text DEFAULT 'initial' NOT NULL,
	"original_case_id" uuid,
	"status" text DEFAULT 'submitted' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assigned_worker_user_id" uuid,
	"final_decision_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "moderation_cases_kind_check" CHECK ("moderation_cases"."kind" IN ('initial', 'appeal')),
	CONSTRAINT "moderation_cases_status_check" CHECK ("moderation_cases"."status" IN ('submitted', 'triaged', 'under_review', 'actioned', 'dismissed')),
	CONSTRAINT "moderation_cases_priority_check" CHECK ("moderation_cases"."priority" IN ('normal', 'high', 'emergency')),
	CONSTRAINT "moderation_cases_origin_check" CHECK (
    ("moderation_cases"."kind" = 'initial' AND "moderation_cases"."original_case_id" IS NULL)
    OR ("moderation_cases"."kind" = 'appeal' AND "moderation_cases"."original_case_id" IS NOT NULL)
  ),
	CONSTRAINT "moderation_cases_final_check" CHECK (
    ("moderation_cases"."status" IN ('actioned', 'dismissed') AND "moderation_cases"."finalized_at" IS NOT NULL AND "moderation_cases"."final_decision_summary" IS NOT NULL)
    OR ("moderation_cases"."status" NOT IN ('actioned', 'dismissed') AND "moderation_cases"."finalized_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "moderation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"classification" text DEFAULT 'ordinary' NOT NULL,
	"locator" jsonb NOT NULL,
	"integrity_sha256" varchar(64) NOT NULL,
	"preserve_until" timestamp with time zone NOT NULL,
	"quarantined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_evidence_report_kind_hash_unique" UNIQUE("report_id","kind","integrity_sha256"),
	CONSTRAINT "moderation_evidence_kind_check" CHECK ("moderation_evidence"."kind" IN ('target_snapshot', 'message_reference', 'profile_reference', 'photo_reference')),
	CONSTRAINT "moderation_evidence_classification_check" CHECK ("moderation_evidence"."classification" IN ('ordinary', 'restricted_safety')),
	CONSTRAINT "moderation_evidence_hash_check" CHECK (char_length("moderation_evidence"."integrity_sha256") = 64),
	CONSTRAINT "moderation_evidence_quarantine_check" CHECK ("moderation_evidence"."classification" <> 'restricted_safety' OR "moderation_evidence"."quarantined_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "moderation_evidence_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"purpose_code" varchar(80) NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_evidence_access_role_check" CHECK ("moderation_evidence_access"."actor_role" IN ('case_worker', 'safety_specialist', 'legal_reviewer'))
);
--> statement-breakpoint
CREATE TABLE "moderation_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_outbox_status_check" CHECK ("moderation_outbox_events"."status" IN ('pending', 'processing', 'published', 'failed')),
	CONSTRAINT "moderation_outbox_attempts_check" CHECK ("moderation_outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"target_profile_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"message_id" uuid,
	"conversation_id" uuid,
	"reason_code" varchar(40) NOT NULL,
	"locale" varchar(35) NOT NULL,
	"explanation" text NOT NULL,
	"client_id" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"dedupe_key" varchar(64) NOT NULL,
	"target_snapshot" jsonb NOT NULL,
	"public_status" text DEFAULT 'submitted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_reporter_client_unique" UNIQUE("reporter_user_id","client_id"),
	CONSTRAINT "reports_not_self_check" CHECK ("reports"."reporter_user_id" <> "reports"."target_user_id"),
	CONSTRAINT "reports_target_type_check" CHECK ("reports"."target_type" IN ('profile', 'message')),
	CONSTRAINT "reports_reason_check" CHECK ("reports"."reason_code" IN ('HARASSMENT', 'HATE_OR_ABUSE', 'IMPERSONATION', 'MINOR_SAFETY', 'SCAM_OR_FRAUD', 'SEXUAL_CONTENT', 'SPAM', 'THREATS_OR_VIOLENCE', 'OTHER_SAFETY')),
	CONSTRAINT "reports_locale_length_check" CHECK (char_length("reports"."locale") BETWEEN 2 AND 35),
	CONSTRAINT "reports_explanation_length_check" CHECK (char_length("reports"."explanation") BETWEEN 1 AND 1000),
	CONSTRAINT "reports_hash_length_check" CHECK (char_length("reports"."request_hash") = 64 AND char_length("reports"."dedupe_key") = 64),
	CONSTRAINT "reports_public_status_check" CHECK ("reports"."public_status" IN ('submitted', 'in_review', 'resolved')),
	CONSTRAINT "reports_message_reference_check" CHECK (
    ("reports"."target_type" = 'profile' AND "reports"."message_id" IS NULL AND "reports"."conversation_id" IS NULL)
    OR ("reports"."target_type" = 'message' AND "reports"."message_id" IS NOT NULL AND "reports"."conversation_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "risk_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"signal_type" varchar(80) NOT NULL,
	"confidence_basis_points" integer NOT NULL,
	"source" text DEFAULT 'report_triage' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_signals_report_type_unique" UNIQUE("report_id","signal_type"),
	CONSTRAINT "risk_signals_confidence_check" CHECK ("risk_signals"."confidence_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "risk_signals_source_check" CHECK ("risk_signals"."source" IN ('report_triage', 'case_worker', 'trusted_provider'))
);
--> statement-breakpoint
CREATE TABLE "safety_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"designated_role" text DEFAULT 'safety_specialist' NOT NULL,
	"severity" text DEFAULT 'emergency' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "safety_alerts_dedupe_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "safety_alerts_role_check" CHECK ("safety_alerts"."designated_role" = 'safety_specialist'),
	CONSTRAINT "safety_alerts_severity_check" CHECK ("safety_alerts"."severity" = 'emergency'),
	CONSTRAINT "safety_alerts_status_check" CHECK ("safety_alerts"."status" IN ('pending', 'acknowledged', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "user_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"source_case_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"reason_code" varchar(80) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_restrictions_case_scope_unique" UNIQUE("source_case_id","scope"),
	CONSTRAINT "user_restrictions_scope_check" CHECK ("user_restrictions"."scope" IN ('all_interactions', 'messaging', 'discovery')),
	CONSTRAINT "user_restrictions_window_check" CHECK ("user_restrictions"."expires_at" > "user_restrictions"."starts_at"),
	CONSTRAINT "user_restrictions_revocation_check" CHECK (("user_restrictions"."active" AND "user_restrictions"."revoked_at" IS NULL) OR (NOT "user_restrictions"."active" AND "user_restrictions"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_appellant_user_id_users_id_fk" FOREIGN KEY ("appellant_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_original_case_id_moderation_cases_id_fk" FOREIGN KEY ("original_case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_review_case_id_moderation_cases_id_fk" FOREIGN KEY ("review_case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_workflow_tasks" ADD CONSTRAINT "legal_workflow_tasks_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_audit_events" ADD CONSTRAINT "moderation_audit_events_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_audit_events" ADD CONSTRAINT "moderation_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_assigned_worker_user_id_users_id_fk" FOREIGN KEY ("assigned_worker_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_original_case_fk" FOREIGN KEY ("original_case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_evidence" ADD CONSTRAINT "moderation_evidence_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_evidence" ADD CONSTRAINT "moderation_evidence_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_evidence_access" ADD CONSTRAINT "moderation_evidence_access_evidence_id_moderation_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."moderation_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_evidence_access" ADD CONSTRAINT "moderation_evidence_access_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_outbox_events" ADD CONSTRAINT "moderation_outbox_events_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_profile_id_profiles_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_alerts" ADD CONSTRAINT "safety_alerts_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_source_case_id_moderation_cases_id_fk" FOREIGN KEY ("source_case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appeals_appellant_created_idx" ON "appeals" USING btree ("appellant_user_id","created_at");--> statement-breakpoint
CREATE INDEX "legal_workflow_tasks_queue_idx" ON "legal_workflow_tasks" USING btree ("jurisdiction_code","status","due_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_case_created_idx" ON "moderation_actions" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_subject_created_idx" ON "moderation_actions" USING btree ("subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_audit_case_created_idx" ON "moderation_audit_events" USING btree ("case_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_initial_report_unique" ON "moderation_cases" USING btree ("report_id") WHERE "moderation_cases"."kind" = 'initial';--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_appeal_original_unique" ON "moderation_cases" USING btree ("original_case_id") WHERE "moderation_cases"."kind" = 'appeal';--> statement-breakpoint
CREATE INDEX "moderation_cases_queue_idx" ON "moderation_cases" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "moderation_evidence_case_idx" ON "moderation_evidence" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_evidence_classification_idx" ON "moderation_evidence" USING btree ("classification","preserve_until");--> statement-breakpoint
CREATE INDEX "moderation_evidence_access_evidence_idx" ON "moderation_evidence_access" USING btree ("evidence_id","accessed_at");--> statement-breakpoint
CREATE INDEX "moderation_evidence_access_actor_idx" ON "moderation_evidence_access" USING btree ("actor_user_id","accessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_outbox_dedupe_unique" ON "moderation_outbox_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "moderation_outbox_claim_idx" ON "moderation_outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_active_dedupe_unique" ON "reports" USING btree ("dedupe_key") WHERE "reports"."public_status" IN ('submitted', 'in_review');--> statement-breakpoint
CREATE INDEX "reports_owner_created_idx" ON "reports" USING btree ("reporter_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "reports_target_created_idx" ON "reports" USING btree ("target_user_id","created_at");--> statement-breakpoint
CREATE INDEX "risk_signals_subject_created_idx" ON "risk_signals" USING btree ("subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX "safety_alerts_queue_idx" ON "safety_alerts" USING btree ("designated_role","status","created_at");--> statement-breakpoint
CREATE INDEX "user_restrictions_subject_scope_active_idx" ON "user_restrictions" USING btree ("subject_user_id","scope","active","expires_at");
--> statement-breakpoint
CREATE FUNCTION prevent_moderation_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MODERATION_LEDGER_APPEND_ONLY';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_actions_append_only
BEFORE UPDATE OR DELETE ON moderation_actions
FOR EACH ROW EXECUTE FUNCTION prevent_moderation_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER moderation_audit_events_append_only
BEFORE UPDATE OR DELETE ON moderation_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_moderation_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER moderation_evidence_access_append_only
BEFORE UPDATE OR DELETE ON moderation_evidence_access
FOR EACH ROW EXECUTE FUNCTION prevent_moderation_ledger_mutation();
