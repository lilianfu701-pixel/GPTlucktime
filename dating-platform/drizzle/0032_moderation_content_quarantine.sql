CREATE TABLE "moderation_content_quarantines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"content_id" uuid NOT NULL,
	"reason_code" varchar(80) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"preserve_until" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_content_quarantines_type_check" CHECK ("moderation_content_quarantines"."content_type" IN ('profile', 'message', 'photo')),
	CONSTRAINT "moderation_content_quarantines_window_check" CHECK ("moderation_content_quarantines"."preserve_until" > "moderation_content_quarantines"."starts_at"),
	CONSTRAINT "moderation_content_quarantines_release_check" CHECK (
    ("moderation_content_quarantines"."active" AND "moderation_content_quarantines"."released_at" IS NULL)
    OR (NOT "moderation_content_quarantines"."active" AND "moderation_content_quarantines"."released_at" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "moderation_content_quarantines" ADD CONSTRAINT "moderation_content_quarantines_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_content_quarantines" ADD CONSTRAINT "moderation_content_quarantines_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_content_quarantines_active_unique" ON "moderation_content_quarantines" USING btree ("content_type","content_id") WHERE "moderation_content_quarantines"."active";--> statement-breakpoint
CREATE INDEX "moderation_content_quarantines_lookup_idx" ON "moderation_content_quarantines" USING btree ("content_type","content_id","active","preserve_until");--> statement-breakpoint
CREATE INDEX "moderation_content_quarantines_case_idx" ON "moderation_content_quarantines" USING btree ("case_id","created_at");