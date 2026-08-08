CREATE TABLE "media_review_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_version" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_review_results_job_attempt_unique" UNIQUE("job_id","attempt"),
	CONSTRAINT "media_review_results_attempt_check" CHECK ("media_review_results"."attempt" > 0),
	CONSTRAINT "media_review_results_outcome_check" CHECK ("media_review_results"."outcome" IN ('approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "media_review_results" ADD CONSTRAINT "media_review_results_job_id_media_review_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."media_review_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_review_results" ADD CONSTRAINT "media_review_results_photo_id_profile_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."profile_photos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_review_results_photo_idx" ON "media_review_results" USING btree ("photo_id","created_at");--> statement-breakpoint
CREATE FUNCTION prevent_media_review_result_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MEDIA_REVIEW_RESULTS_APPEND_ONLY';
END;
$$;--> statement-breakpoint
CREATE TRIGGER media_review_results_append_only
BEFORE UPDATE OR DELETE ON media_review_results
FOR EACH ROW EXECUTE FUNCTION prevent_media_review_result_mutation();
