CREATE TABLE "moderation_media_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"object_version" text NOT NULL,
	"snapshot_sha256" varchar(64) NOT NULL,
	"preserve_until" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_media_holds_report_photo_unique" UNIQUE("report_id","photo_id"),
	CONSTRAINT "moderation_media_holds_hash_check" CHECK (char_length("moderation_media_holds"."snapshot_sha256") = 64),
	CONSTRAINT "moderation_media_holds_release_check" CHECK (
    ("moderation_media_holds"."active" AND "moderation_media_holds"."released_at" IS NULL)
    OR (NOT "moderation_media_holds"."active" AND "moderation_media_holds"."released_at" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD CONSTRAINT "moderation_media_holds_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD CONSTRAINT "moderation_media_holds_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD CONSTRAINT "moderation_media_holds_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD CONSTRAINT "moderation_media_holds_photo_id_profile_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."profile_photos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_media_holds_photo_active_idx" ON "moderation_media_holds" USING btree ("photo_id","active","preserve_until");
--> statement-breakpoint
CREATE FUNCTION enforce_message_moderation_restriction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM users WHERE id IN (NEW.low_user_id, NEW.high_user_id) ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM user_restrictions
    WHERE subject_user_id IN (NEW.low_user_id, NEW.high_user_id)
      AND active = true
      AND starts_at <= NEW.created_at
      AND expires_at > NEW.created_at
      AND scope IN ('all_interactions', 'messaging')
  ) THEN
    RAISE EXCEPTION 'MESSAGE_INSERT_NOT_AVAILABLE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER messages_enforce_moderation_restriction
BEFORE INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION enforce_message_moderation_restriction();
--> statement-breakpoint
CREATE FUNCTION validate_moderation_cross_row_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE report_subject uuid; case_report uuid;
BEGIN
  IF TG_TABLE_NAME = 'moderation_actions' THEN
    SELECT c.report_id, r.target_user_id INTO case_report, report_subject
      FROM moderation_cases c JOIN reports r ON r.id = c.report_id WHERE c.id = NEW.case_id;
    IF case_report IS NULL OR report_subject <> NEW.subject_user_id THEN RAISE EXCEPTION 'MODERATION_RELATION_INVALID'; END IF;
  ELSIF TG_TABLE_NAME = 'moderation_evidence' THEN
    SELECT report_id INTO case_report FROM moderation_cases WHERE id = NEW.case_id;
    IF case_report IS NULL OR case_report <> NEW.report_id THEN RAISE EXCEPTION 'MODERATION_RELATION_INVALID'; END IF;
  ELSIF TG_TABLE_NAME = 'moderation_media_holds' THEN
    SELECT c.report_id, r.target_user_id INTO case_report, report_subject
      FROM moderation_cases c JOIN reports r ON r.id = c.report_id WHERE c.id = NEW.case_id;
    IF case_report IS NULL OR case_report <> NEW.report_id OR report_subject <> NEW.subject_user_id THEN
      RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_actions_validate_relation BEFORE INSERT ON moderation_actions
FOR EACH ROW EXECUTE FUNCTION validate_moderation_cross_row_consistency();
--> statement-breakpoint
CREATE TRIGGER moderation_evidence_validate_relation BEFORE INSERT ON moderation_evidence
FOR EACH ROW EXECUTE FUNCTION validate_moderation_cross_row_consistency();
--> statement-breakpoint
CREATE TRIGGER moderation_media_holds_validate_relation BEFORE INSERT ON moderation_media_holds
FOR EACH ROW EXECUTE FUNCTION validate_moderation_cross_row_consistency();
--> statement-breakpoint
CREATE FUNCTION protect_moderation_media_hold_facts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE'; END IF;
  IF ROW(NEW.id, NEW.report_id, NEW.case_id, NEW.subject_user_id, NEW.photo_id, NEW.object_key,
    NEW.object_version, NEW.snapshot_sha256, NEW.preserve_until, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.report_id, OLD.case_id, OLD.subject_user_id, OLD.photo_id, OLD.object_key,
    OLD.object_version, OLD.snapshot_sha256, OLD.preserve_until, OLD.created_at) THEN
    RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_media_holds_protect_facts BEFORE UPDATE OR DELETE ON moderation_media_holds
FOR EACH ROW EXECUTE FUNCTION protect_moderation_media_hold_facts();
