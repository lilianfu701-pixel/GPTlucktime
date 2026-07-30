CREATE TABLE "anniversary_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"calendar_id" text NOT NULL,
	"adapter_version" text NOT NULL,
	"source_year" integer NOT NULL,
	"source_month" integer NOT NULL,
	"source_day" integer NOT NULL,
	"time_zone" text NOT NULL,
	"next_occurrence_at" timestamp with time zone,
	"last_enqueued_at" timestamp with time zone,
	"last_error" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anniversary_reminders" ADD CONSTRAINT "anniversary_reminders_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anniversary_reminders_due_idx" ON "anniversary_reminders" USING btree ("enabled","next_occurrence_at");--> statement-breakpoint
CREATE INDEX "anniversary_reminders_memorial_idx" ON "anniversary_reminders" USING btree ("memorial_id");