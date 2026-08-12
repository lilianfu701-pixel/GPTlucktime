CREATE TABLE "moderation_media_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"source_object_key" text NOT NULL,
	"source_object_version" text NOT NULL,
	"source_object_etag" text NOT NULL,
	"object_key" text NOT NULL,
	"object_version" text NOT NULL,
	"object_etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_media_copies_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "moderation_media_copies_report_photo_unique" UNIQUE("report_id","photo_id")
);
--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD COLUMN "evidence_copy_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "object_version" text;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "object_etag" text;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "deletion_status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "deletion_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "deletion_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_photo_id_profile_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."profile_photos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_media_copies_case_idx" ON "moderation_media_copies" USING btree ("case_id","created_at");--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD CONSTRAINT "moderation_media_holds_evidence_copy_id_moderation_media_copies_id_fk" FOREIGN KEY ("evidence_copy_id") REFERENCES "public"."moderation_media_copies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_deletion_status_check" CHECK ("profile_photos"."deletion_status" IN ('idle', 'claimed', 'deleting'));--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_deletion_lease_check" CHECK (
      ("profile_photos"."deletion_status" = 'idle' AND "profile_photos"."deletion_lease_id" IS NULL AND "profile_photos"."deletion_lease_expires_at" IS NULL)
      OR ("profile_photos"."deletion_status" IN ('claimed', 'deleting') AND "profile_photos"."deletion_lease_id" IS NOT NULL
        AND "profile_photos"."deletion_lease_expires_at" IS NOT NULL)
    );--> statement-breakpoint
CREATE FUNCTION validate_moderation_content_quarantine_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  case_report uuid;
  report_subject uuid;
  report_profile uuid;
  report_message uuid;
  report_conversation uuid;
BEGIN
  SELECT c.report_id, r.target_user_id, r.target_profile_id, r.message_id, r.conversation_id
    INTO case_report, report_subject, report_profile, report_message, report_conversation
    FROM moderation_cases c
    JOIN reports r ON r.id = c.report_id
    WHERE c.id = NEW.case_id;

  IF case_report IS NULL OR case_report <> NEW.report_id THEN
    RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
  END IF;

  IF NEW.content_type = 'profile' THEN
    IF NEW.content_id <> report_profile THEN
      RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
    END IF;
  ELSIF NEW.content_type = 'photo' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM profile_photos p
      WHERE p.id = NEW.content_id AND p.user_id = report_subject
    ) OR NOT EXISTS (
      SELECT 1
      FROM moderation_evidence e
      WHERE e.case_id = NEW.case_id
        AND e.report_id = NEW.report_id
        AND e.locator->>'referenceType' = 'photo'
        AND e.locator->>'referenceId' = NEW.content_id::text
    ) THEN
      RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
    END IF;
  ELSIF NEW.content_type = 'message' THEN
    IF report_message IS NULL OR NEW.content_id <> report_message OR NOT EXISTS (
      SELECT 1
      FROM messages m
      WHERE m.id = NEW.content_id
        AND m.sender_user_id = report_subject
        AND m.conversation_id = report_conversation
    ) THEN
      RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
    END IF;
  ELSE
    RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER moderation_content_quarantines_validate_target
BEFORE INSERT OR UPDATE ON moderation_content_quarantines
FOR EACH ROW EXECUTE FUNCTION validate_moderation_content_quarantine_target();--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_message_moderation_restriction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM users WHERE id IN (NEW.low_user_id, NEW.high_user_id) ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM user_restrictions
    WHERE subject_user_id IN (NEW.low_user_id, NEW.high_user_id)
      AND active = true
      AND starts_at <= statement_timestamp()
      AND expires_at > statement_timestamp()
      AND scope IN ('all_interactions', 'messaging')
  ) THEN
    RAISE EXCEPTION 'MESSAGE_INSERT_NOT_AVAILABLE';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION validate_moderation_media_copy_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  case_report uuid;
  report_subject uuid;
  photo_subject uuid;
  photo_key text;
  photo_version text;
  photo_etag text;
BEGIN
  SELECT c.report_id, r.target_user_id
    INTO case_report, report_subject
    FROM moderation_cases c
    JOIN reports r ON r.id = c.report_id
    WHERE c.id = NEW.case_id;
  SELECT p.user_id, p.object_key, p.object_version, p.object_etag
    INTO photo_subject, photo_key, photo_version, photo_etag
    FROM profile_photos p
    WHERE p.id = NEW.photo_id;

  IF case_report IS NULL
    OR case_report <> NEW.report_id
    OR report_subject <> NEW.subject_user_id
    OR photo_subject IS NULL
    OR photo_subject <> NEW.subject_user_id
    OR photo_key IS DISTINCT FROM NEW.source_object_key
    OR photo_version IS DISTINCT FROM NEW.source_object_version
    OR photo_etag IS DISTINCT FROM NEW.source_object_etag THEN
    RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER moderation_media_copies_validate_relation
BEFORE INSERT OR UPDATE ON moderation_media_copies
FOR EACH ROW EXECUTE FUNCTION validate_moderation_media_copy_relation();--> statement-breakpoint
CREATE FUNCTION protect_moderation_media_copy_facts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW.id, NEW.report_id, NEW.case_id, NEW.subject_user_id, NEW.photo_id,
    NEW.source_object_key, NEW.source_object_version, NEW.source_object_etag,
    NEW.object_key, NEW.object_version, NEW.object_etag, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.report_id, OLD.case_id, OLD.subject_user_id, OLD.photo_id,
    OLD.source_object_key, OLD.source_object_version, OLD.source_object_etag,
    OLD.object_key, OLD.object_version, OLD.object_etag, OLD.created_at) THEN
    RAISE EXCEPTION 'MODERATION_MEDIA_COPY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER moderation_media_copies_protect_facts
BEFORE UPDATE OR DELETE ON moderation_media_copies
FOR EACH ROW EXECUTE FUNCTION protect_moderation_media_copy_facts();--> statement-breakpoint
CREATE FUNCTION validate_moderation_media_hold_copy_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_copy_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM moderation_media_copies copy
    WHERE copy.id = NEW.evidence_copy_id
      AND copy.report_id = NEW.report_id
      AND copy.case_id = NEW.case_id
      AND copy.subject_user_id = NEW.subject_user_id
      AND copy.photo_id = NEW.photo_id
      AND copy.object_key = NEW.object_key
      AND copy.object_version = NEW.object_version
  ) THEN
    RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER moderation_media_holds_validate_copy_relation
BEFORE INSERT OR UPDATE ON moderation_media_holds
FOR EACH ROW EXECUTE FUNCTION validate_moderation_media_hold_copy_relation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_moderation_media_hold_facts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE'; END IF;
  IF ROW(NEW.id, NEW.report_id, NEW.case_id, NEW.subject_user_id, NEW.photo_id, NEW.evidence_copy_id,
    NEW.object_key, NEW.object_version, NEW.snapshot_sha256, NEW.preserve_until, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.report_id, OLD.case_id, OLD.subject_user_id, OLD.photo_id, OLD.evidence_copy_id,
    OLD.object_key, OLD.object_version, OLD.snapshot_sha256, OLD.preserve_until, OLD.created_at) THEN
    RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
