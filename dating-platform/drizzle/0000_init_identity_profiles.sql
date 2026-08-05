CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_account_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interests_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "privacy_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"show_online_status" boolean DEFAULT true NOT NULL,
	"show_last_active" boolean DEFAULT true NOT NULL,
	"show_profile_visitors" boolean DEFAULT true NOT NULL,
	"location_precision" text DEFAULT 'city' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_settings_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "privacy_settings_location_precision_check" CHECK ("privacy_settings"."location_precision" IN ('hidden', 'country', 'city', 'approximate'))
);
--> statement-breakpoint
CREATE TABLE "profile_interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"interest_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_interests_profile_interest_unique" UNIQUE("profile_id","interest_id")
);
--> statement-breakpoint
CREATE TABLE "profile_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"moderation_status" text DEFAULT 'pending' NOT NULL,
	"moderation_reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_photos_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "profile_photos_position_check" CHECK ("profile_photos"."position" >= 0),
	CONSTRAINT "profile_photos_moderation_status_check" CHECK ("profile_photos"."moderation_status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "profile_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"gender_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"minimum_age" integer DEFAULT 18 NOT NULL,
	"maximum_age" integer DEFAULT 100 NOT NULL,
	"preferred_country_codes" varchar(2)[] DEFAULT '{}'::varchar(2)[] NOT NULL,
	"language_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"relationship_goal_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_preferences_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "profile_preferences_age_range_check" CHECK ("profile_preferences"."minimum_age" >= 18 AND "profile_preferences"."maximum_age" <= 120 AND "profile_preferences"."minimum_age" <= "profile_preferences"."maximum_age"),
	CONSTRAINT "profile_preferences_country_codes_format_check" CHECK (array_position("profile_preferences"."preferred_country_codes", NULL) IS NULL
        AND (
          cardinality("profile_preferences"."preferred_country_codes") = 0
          OR array_to_string("profile_preferences"."preferred_country_codes", ',')
            ~ '^([A-Z]{2})(,[A-Z]{2})*$'
        ))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"birth_date" date NOT NULL,
	"gender_code" text NOT NULL,
	"relationship_goal_code" text,
	"country_code" varchar(2) NOT NULL,
	"city" text,
	"bio" text,
	"discoverable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "profiles_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "profiles_country_code_format_check" CHECK ("profiles"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "profiles_status_check" CHECK ("profiles"."status" IN ('draft', 'active', 'restricted', 'suspended', 'banned'))
);
--> statement-breakpoint
CREATE TABLE "verification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"provider_reference" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_attempts_status_check" CHECK ("verification_attempts"."status" IN ('pending', 'approved', 'rejected', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_interests" ADD CONSTRAINT "profile_interests_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_interests" ADD CONSTRAINT "profile_interests_interest_id_interests_id_fk" FOREIGN KEY ("interest_id") REFERENCES "public"."interests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_profile_owner_fk" FOREIGN KEY ("profile_id","user_id") REFERENCES "public"."profiles"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_preferences" ADD CONSTRAINT "profile_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "profile_interests_interest_idx" ON "profile_interests" USING btree ("interest_id");--> statement-breakpoint
CREATE INDEX "profile_photos_moderation_status_idx" ON "profile_photos" USING btree ("moderation_status");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_photos_profile_position_unique_idx" ON "profile_photos" USING btree ("profile_id","position");--> statement-breakpoint
CREATE INDEX "profiles_discovery_idx" ON "profiles" USING btree ("discoverable","status");--> statement-breakpoint
CREATE INDEX "profiles_country_birth_date_idx" ON "profiles" USING btree ("country_code","birth_date");--> statement-breakpoint
CREATE INDEX "verification_attempts_user_idx" ON "verification_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_attempts_status_idx" ON "verification_attempts" USING btree ("status");