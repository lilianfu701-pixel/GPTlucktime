CREATE TYPE "public"."family_link_kind" AS ENUM('parent', 'partner');--> statement-breakpoint
CREATE TYPE "public"."family_link_source" AS ENUM('declared', 'suggestion');--> statement-breakpoint
CREATE TYPE "public"."family_link_status" AS ENUM('proposed', 'confirmed', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."life_status" AS ENUM('living', 'deceased', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."parent_nature" AS ENUM('unspecified', 'birth', 'adoptive', 'step', 'foster');--> statement-breakpoint
CREATE TABLE "family_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "family_link_kind" NOT NULL,
	"person_a_id" uuid NOT NULL,
	"person_b_id" uuid NOT NULL,
	"nature" "parent_nature" DEFAULT 'unspecified' NOT NULL,
	"status" "family_link_status" DEFAULT 'proposed' NOT NULL,
	"source" "family_link_source" DEFAULT 'declared' NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_links_distinct_ck" CHECK ("family_links"."person_a_id" <> "family_links"."person_b_id"),
	CONSTRAINT "family_links_partner_order_ck" CHECK ("family_links"."kind" <> 'partner' or "family_links"."person_a_id" < "family_links"."person_b_id"),
	CONSTRAINT "family_links_nature_ck" CHECK ("family_links"."kind" = 'parent' or "family_links"."nature" = 'unspecified')
);
--> statement-breakpoint
CREATE TABLE "family_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deceased_person_id" uuid,
	"display_name" text,
	"life_status" "life_status" DEFAULT 'unknown' NOT NULL,
	"birth_year" integer,
	"death_year" integer,
	"self_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_people_identity_ck" CHECK (("family_people"."deceased_person_id" is not null and "family_people"."display_name" is null)
          or ("family_people"."deceased_person_id" is null and "family_people"."display_name" is not null)),
	CONSTRAINT "family_people_self_is_living_ck" CHECK ("family_people"."self_user_id" is null or "family_people"."life_status" = 'living')
);
--> statement-breakpoint
ALTER TABLE "family_links" ADD CONSTRAINT "family_links_person_a_id_family_people_id_fk" FOREIGN KEY ("person_a_id") REFERENCES "public"."family_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_links" ADD CONSTRAINT "family_links_person_b_id_family_people_id_fk" FOREIGN KEY ("person_b_id") REFERENCES "public"."family_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_links" ADD CONSTRAINT "family_links_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_links" ADD CONSTRAINT "family_links_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_people" ADD CONSTRAINT "family_people_deceased_person_id_deceased_people_id_fk" FOREIGN KEY ("deceased_person_id") REFERENCES "public"."deceased_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_people" ADD CONSTRAINT "family_people_self_user_id_users_id_fk" FOREIGN KEY ("self_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_people" ADD CONSTRAINT "family_people_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_links_pair_key" ON "family_links" USING btree ("kind","person_a_id","person_b_id");--> statement-breakpoint
CREATE INDEX "family_links_a_idx" ON "family_links" USING btree ("person_a_id","status");--> statement-breakpoint
CREATE INDEX "family_links_b_idx" ON "family_links" USING btree ("person_b_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "family_people_deceased_key" ON "family_people" USING btree ("deceased_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "family_people_self_key" ON "family_people" USING btree ("self_user_id");--> statement-breakpoint
CREATE INDEX "family_people_creator_idx" ON "family_people" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "family_people_name_idx" ON "family_people" USING btree ("display_name");