CREATE TABLE "media_preservation_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"source_object_key" text NOT NULL,
	"destination_object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"evidence_copy_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "media_preservation_tasks_destination_object_key_unique" UNIQUE("destination_object_key"),
	CONSTRAINT "media_preservation_tasks_report_photo_unique" UNIQUE("report_id","photo_id"),
	CONSTRAINT "media_preservation_tasks_status_check" CHECK ("media_preservation_tasks"."status" IN ('pending', 'processing', 'completed', 'manual_review')),
	CONSTRAINT "media_preservation_tasks_attempts_check" CHECK ("media_preservation_tasks"."attempts" >= 0),
	CONSTRAINT "media_preservation_tasks_lease_check" CHECK (
    ("media_preservation_tasks"."status" = 'processing' AND "media_preservation_tasks"."lease_id" IS NOT NULL AND "media_preservation_tasks"."lease_expires_at" IS NOT NULL)
    OR ("media_preservation_tasks"."status" <> 'processing' AND "media_preservation_tasks"."lease_id" IS NULL AND "media_preservation_tasks"."lease_expires_at" IS NULL)
  ),
	CONSTRAINT "media_preservation_tasks_completion_check" CHECK (
    ("media_preservation_tasks"."status" = 'completed' AND "media_preservation_tasks"."evidence_copy_id" IS NOT NULL AND "media_preservation_tasks"."completed_at" IS NOT NULL)
    OR ("media_preservation_tasks"."status" <> 'completed' AND "media_preservation_tasks"."completed_at" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD COLUMN "capture_mode" text DEFAULT 'immutable_version' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD COLUMN "legacy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD COLUMN "released_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "preservation_status" text DEFAULT 'versioned' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_preservation_tasks" ADD CONSTRAINT "media_preservation_tasks_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_preservation_tasks" ADD CONSTRAINT "media_preservation_tasks_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_preservation_tasks" ADD CONSTRAINT "media_preservation_tasks_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_preservation_tasks" ADD CONSTRAINT "media_preservation_tasks_photo_id_profile_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."profile_photos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_preservation_tasks" ADD CONSTRAINT "media_preservation_tasks_evidence_copy_id_moderation_media_copies_id_fk" FOREIGN KEY ("evidence_copy_id") REFERENCES "public"."moderation_media_copies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_preservation_tasks_claim_idx" ON "media_preservation_tasks" USING btree ("status","lease_expires_at","created_at");--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD CONSTRAINT "moderation_media_holds_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_media_copies" ADD CONSTRAINT "moderation_media_copies_capture_mode_check" CHECK ("moderation_media_copies"."capture_mode" IN ('immutable_version', 'current_object_etag'));--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_preservation_status_check" CHECK ("profile_photos"."preservation_status" IN ('versioned', 'legacy_unversioned', 'preservation_pending', 'legacy_preserved'));--> statement-breakpoint
CREATE FUNCTION classify_profile_photo_preservation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.object_version IS NULL OR NEW.object_etag IS NULL THEN
    NEW.preservation_status := 'legacy_unversioned';
  ELSE
    NEW.preservation_status := 'versioned';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER profile_photos_classify_preservation
BEFORE INSERT ON profile_photos
FOR EACH ROW EXECUTE FUNCTION classify_profile_photo_preservation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_moderation_media_copy_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  case_report uuid;
  report_subject uuid;
  photo_subject uuid;
  photo_key text;
  photo_version text;
  photo_etag text;
BEGIN
  SELECT c.report_id, r.target_user_id INTO case_report, report_subject
    FROM moderation_cases c JOIN reports r ON r.id = c.report_id WHERE c.id = NEW.case_id;
  SELECT p.user_id, p.object_key, p.object_version, p.object_etag
    INTO photo_subject, photo_key, photo_version, photo_etag
    FROM profile_photos p WHERE p.id = NEW.photo_id;

  IF case_report IS NULL OR case_report <> NEW.report_id OR report_subject <> NEW.subject_user_id
    OR photo_subject IS NULL OR photo_subject <> NEW.subject_user_id
    OR photo_key IS DISTINCT FROM NEW.source_object_key THEN
    RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
  END IF;
  IF NEW.capture_mode = 'immutable_version' THEN
    IF NEW.source_object_version IS NULL
      OR photo_version IS DISTINCT FROM NEW.source_object_version
      OR photo_etag IS DISTINCT FROM NEW.source_object_etag THEN
      RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
    END IF;
  ELSIF NEW.capture_mode = 'current_object_etag' THEN
    IF NEW.source_object_etag = '' OR NOT EXISTS (
      SELECT 1 FROM media_preservation_tasks task
      WHERE task.report_id = NEW.report_id AND task.case_id = NEW.case_id
        AND task.subject_user_id = NEW.subject_user_id AND task.photo_id = NEW.photo_id
        AND task.source_object_key = NEW.source_object_key
        AND task.destination_object_key = NEW.object_key AND task.status = 'processing'
    ) THEN
      RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
    END IF;
  ELSE
    RAISE EXCEPTION 'MODERATION_RELATION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_moderation_media_hold_copy_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE case_report uuid; report_subject uuid; photo_subject uuid;
BEGIN
  IF NEW.legacy AND NEW.evidence_copy_id IS NULL THEN
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
$$;--> statement-breakpoint
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
  IF NEW.legacy <> OLD.legacy THEN
    IF NOT (OLD.legacy = false AND NEW.legacy = true AND OLD.evidence_copy_id IS NULL) THEN
      RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE';
    END IF;
  END IF;
  IF OLD.active = false AND ROW(NEW.active, NEW.released_at, NEW.released_by_user_id)
    IS DISTINCT FROM ROW(OLD.active, OLD.released_at, OLD.released_by_user_id) THEN
    RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION validate_media_preservation_task_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM moderation_cases c
    JOIN reports r ON r.id = c.report_id
    JOIN profile_photos p ON p.id = NEW.photo_id
    WHERE c.id = NEW.case_id AND c.report_id = NEW.report_id
      AND r.target_user_id = NEW.subject_user_id AND p.user_id = NEW.subject_user_id
      AND p.object_key = NEW.source_object_key
      AND p.preservation_status IN ('legacy_unversioned', 'preservation_pending', 'legacy_preserved')
  ) THEN RAISE EXCEPTION 'MODERATION_RELATION_INVALID'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER media_preservation_tasks_validate_relation
BEFORE INSERT OR UPDATE ON media_preservation_tasks
FOR EACH ROW EXECUTE FUNCTION validate_media_preservation_task_relation();--> statement-breakpoint
UPDATE "moderation_media_holds" SET "legacy" = true WHERE "evidence_copy_id" IS NULL;--> statement-breakpoint
UPDATE "profile_photos"
SET "preservation_status" = 'legacy_unversioned'
WHERE "object_version" IS NULL OR "object_etag" IS NULL;--> statement-breakpoint
ALTER TABLE "moderation_media_holds" ADD CONSTRAINT "moderation_media_holds_release_actor_check" CHECK (
    ("moderation_media_holds"."active" AND "moderation_media_holds"."released_by_user_id" IS NULL)
    OR (NOT "moderation_media_holds"."active" AND ("moderation_media_holds"."legacy" OR "moderation_media_holds"."released_by_user_id" IS NOT NULL))
  );--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_moderation_media_hold_facts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE'; END IF;
  IF ROW(NEW.id, NEW.report_id, NEW.case_id, NEW.subject_user_id, NEW.photo_id, NEW.evidence_copy_id,
    NEW.legacy, NEW.object_key, NEW.object_version, NEW.snapshot_sha256, NEW.preserve_until, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.report_id, OLD.case_id, OLD.subject_user_id, OLD.photo_id, OLD.evidence_copy_id,
    OLD.legacy, OLD.object_key, OLD.object_version, OLD.snapshot_sha256, OLD.preserve_until, OLD.created_at) THEN
    RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE';
  END IF;
  IF OLD.active = false AND ROW(NEW.active, NEW.released_at, NEW.released_by_user_id)
    IS DISTINCT FROM ROW(OLD.active, OLD.released_at, OLD.released_by_user_id) THEN
    RAISE EXCEPTION 'MODERATION_MEDIA_HOLD_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
