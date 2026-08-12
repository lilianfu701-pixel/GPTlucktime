ALTER TABLE "user_restrictions" ADD COLUMN "expiry_policy" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_window_check" CHECK ("moderation_actions"."expires_at" > "moderation_actions"."created_at");--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_expiry_policy_check" CHECK ("user_restrictions"."expiry_policy" IN ('fixed', 'indefinite_review'));
--> statement-breakpoint
CREATE FUNCTION protect_report_facts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MODERATION_REPORT_FACTS_IMMUTABLE';
  END IF;
  IF ROW(
    NEW.id, NEW.reporter_user_id, NEW.target_user_id, NEW.target_profile_id,
    NEW.target_type, NEW.message_id, NEW.conversation_id, NEW.reason_code,
    NEW.locale, NEW.explanation, NEW.client_id, NEW.request_hash,
    NEW.dedupe_key, NEW.target_snapshot, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.reporter_user_id, OLD.target_user_id, OLD.target_profile_id,
    OLD.target_type, OLD.message_id, OLD.conversation_id, OLD.reason_code,
    OLD.locale, OLD.explanation, OLD.client_id, OLD.request_hash,
    OLD.dedupe_key, OLD.target_snapshot, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'MODERATION_REPORT_FACTS_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reports_protect_facts
BEFORE UPDATE OR DELETE ON reports
FOR EACH ROW EXECUTE FUNCTION protect_report_facts();
--> statement-breakpoint
CREATE FUNCTION protect_moderation_case_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MODERATION_CASE_IDENTITY_IMMUTABLE';
  END IF;
  IF ROW(NEW.id, NEW.report_id, NEW.kind, NEW.original_case_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.report_id, OLD.kind, OLD.original_case_id, OLD.created_at) THEN
    RAISE EXCEPTION 'MODERATION_CASE_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_cases_protect_identity
BEFORE UPDATE OR DELETE ON moderation_cases
FOR EACH ROW EXECUTE FUNCTION protect_moderation_case_identity();
--> statement-breakpoint
CREATE FUNCTION protect_moderation_evidence_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MODERATION_EVIDENCE_CONTENT_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_evidence_protect_content
BEFORE UPDATE OR DELETE ON moderation_evidence
FOR EACH ROW EXECUTE FUNCTION protect_moderation_evidence_content();
