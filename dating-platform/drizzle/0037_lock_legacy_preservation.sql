CREATE TABLE "migrated_legacy_media_holds" (
	"hold_id" uuid PRIMARY KEY NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "migrated_legacy_media_holds" ADD CONSTRAINT "migrated_legacy_media_holds_hold_id_moderation_media_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."moderation_media_holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO migrated_legacy_media_holds (hold_id, migrated_at)
SELECT id, now() FROM moderation_media_holds
WHERE legacy = true AND evidence_copy_id IS NULL
ON CONFLICT (hold_id) DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_moderation_media_hold_copy_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE case_report uuid; report_subject uuid; photo_subject uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.legacy AND OLD.evidence_copy_id IS NULL
    AND EXISTS (SELECT 1 FROM migrated_legacy_media_holds registry WHERE registry.hold_id = OLD.id) THEN
    SELECT c.report_id, r.target_user_id INTO case_report, report_subject
      FROM moderation_cases c JOIN reports r ON r.id = c.report_id WHERE c.id = NEW.case_id;
    SELECT user_id INTO photo_subject FROM profile_photos WHERE id = NEW.photo_id;
    IF case_report IS NULL OR case_report <> NEW.report_id OR report_subject <> NEW.subject_user_id
      OR photo_subject <> NEW.subject_user_id OR NOT NEW.legacy OR NEW.evidence_copy_id IS NOT NULL THEN
      RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
    END IF;
  ELSIF NEW.legacy OR NEW.evidence_copy_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM moderation_media_copies copy
    WHERE copy.id = NEW.evidence_copy_id AND copy.report_id = NEW.report_id
      AND copy.case_id = NEW.case_id AND copy.subject_user_id = NEW.subject_user_id
      AND copy.photo_id = NEW.photo_id AND copy.object_key = NEW.object_key
      AND copy.object_version = NEW.object_version
  ) THEN
    RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
