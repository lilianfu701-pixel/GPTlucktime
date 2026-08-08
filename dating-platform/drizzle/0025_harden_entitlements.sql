SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "entitlement_configurations" c
    JOIN "entitlement_definitions" d ON d."key" = c."entitlement_key"
    WHERE c."kind" <> d."kind"
      OR c."upgrade_hint" IS NOT NULL AND c."upgrade_hint" !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
      OR c."scope" = 'global_flag' AND (
        c."boolean_value" IS NOT NULL OR c."quota_limit" IS NOT NULL
        OR c."numeric_value" IS NOT NULL OR c."upgrade_hint" IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM "entitlement_plan_benefits" b
    JOIN "entitlement_definitions" d ON d."key" = b."entitlement_key"
    WHERE b."kind" <> d."kind"
      OR b."upgrade_hint" IS NOT NULL AND b."upgrade_hint" !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
  ) OR EXISTS (
    SELECT 1
    FROM "entitlement_user_overrides" o
    JOIN "entitlement_definitions" d ON d."key" = o."entitlement_key"
    WHERE o."kind" <> d."kind"
      OR o."upgrade_hint" IS NOT NULL AND o."upgrade_hint" !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
  ) THEN
    RAISE EXCEPTION 'entitlement hardening preflight failed: invalid kind, global shape, or public hint';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "entitlement_configurations"
    WHERE "quota_limit" NOT BETWEEN 0 AND 1000000
       OR "numeric_value"::text IN ('Infinity', '-Infinity', 'NaN')
  ) OR EXISTS (
    SELECT 1 FROM "entitlement_plan_benefits"
    WHERE "quota_limit" NOT BETWEEN 0 AND 1000000
       OR "numeric_value"::text IN ('Infinity', '-Infinity', 'NaN')
  ) OR EXISTS (
    SELECT 1 FROM "entitlement_user_overrides"
    WHERE "quota_limit" NOT BETWEEN 0 AND 1000000
       OR "numeric_value"::text IN ('Infinity', '-Infinity', 'NaN')
  ) OR EXISTS (
    SELECT 1 FROM "entitlement_usage_operations"
    WHERE "amount" NOT BETWEEN 1 AND 1000000
       OR "limit" NOT BETWEEN 0 AND 1000000
       OR "remaining" NOT BETWEEN 0 AND 1000000
       OR "value"::text IN ('Infinity', '-Infinity', 'NaN')
       OR "upgrade_hint" IS NOT NULL AND "upgrade_hint" !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
  ) OR EXISTS (
    SELECT 1 FROM "entitlement_usage_counters" WHERE "used" NOT BETWEEN 0 AND 1000000
  ) THEN
    RAISE EXCEPTION 'entitlement hardening preflight failed: value outside supported bounds';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "entitlement_configurations"
    WHERE "numeric_value" IS NOT NULL
      AND ("numeric_value" NOT BETWEEN 0 AND 1000000
        OR "numeric_value" <> round("numeric_value"::numeric, 4))
  ) OR EXISTS (
    SELECT 1 FROM "entitlement_plan_benefits"
    WHERE "numeric_value" IS NOT NULL
      AND ("numeric_value" NOT BETWEEN 0 AND 1000000
        OR "numeric_value" <> round("numeric_value"::numeric, 4))
  ) OR EXISTS (
    SELECT 1 FROM "entitlement_user_overrides"
    WHERE "numeric_value" IS NOT NULL
      AND ("numeric_value" NOT BETWEEN 0 AND 1000000
        OR "numeric_value" <> round("numeric_value"::numeric, 4))
  ) OR EXISTS (
    SELECT 1 FROM "entitlement_usage_operations"
    WHERE "value" IS NOT NULL
      AND ("value" NOT BETWEEN 0 AND 1000000 OR "value" <> round("value"::numeric, 4))
  ) THEN
    RAISE EXCEPTION 'entitlement hardening preflight failed: numeric precision exceeds four decimals';
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE "entitlement_user_plan_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_ref" varchar(80) NOT NULL,
	"version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_user_plan_assignments_user_version_unique" UNIQUE("user_id","version"),
	CONSTRAINT "entitlement_user_plan_assignments_plan_ref_check" CHECK ("entitlement_user_plan_assignments"."plan_ref" ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
	CONSTRAINT "entitlement_user_plan_assignments_version_check" CHECK ("entitlement_user_plan_assignments"."version" > 0),
	CONSTRAINT "entitlement_user_plan_assignments_window_check" CHECK ("entitlement_user_plan_assignments"."expires_at" IS NULL OR "entitlement_user_plan_assignments"."expires_at" > "entitlement_user_plan_assignments"."effective_at")
);
--> statement-breakpoint
ALTER TABLE "entitlement_configurations" DROP CONSTRAINT "entitlement_configurations_quota_check";--> statement-breakpoint
ALTER TABLE "entitlement_configurations" DROP CONSTRAINT "entitlement_configurations_numeric_check";--> statement-breakpoint
ALTER TABLE "entitlement_configurations" DROP CONSTRAINT "entitlement_configurations_value_shape_check";--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" DROP CONSTRAINT "entitlement_plan_benefits_quota_check";--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" DROP CONSTRAINT "entitlement_plan_benefits_numeric_check";--> statement-breakpoint
ALTER TABLE "entitlement_usage_counters" DROP CONSTRAINT "entitlement_usage_counters_used_check";--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" DROP CONSTRAINT "entitlement_usage_operations_amount_check";--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" DROP CONSTRAINT "entitlement_usage_operations_limit_check";--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" DROP CONSTRAINT "entitlement_usage_operations_remaining_check";--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" DROP CONSTRAINT "entitlement_usage_operations_reason_check";--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" DROP CONSTRAINT "entitlement_user_overrides_quota_check";--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" DROP CONSTRAINT "entitlement_user_overrides_numeric_check";--> statement-breakpoint
ALTER TABLE "entitlement_configurations" ALTER COLUMN "numeric_value" SET DATA TYPE numeric(12, 4);--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" ALTER COLUMN "numeric_value" SET DATA TYPE numeric(12, 4);--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ALTER COLUMN "value" SET DATA TYPE numeric(12, 4);--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ALTER COLUMN "numeric_value" SET DATA TYPE numeric(12, 4);--> statement-breakpoint
ALTER TABLE "entitlement_user_plan_assignments" ADD CONSTRAINT "entitlement_user_plan_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entitlement_user_plan_assignments_resolution_idx" ON "entitlement_user_plan_assignments" USING btree ("user_id","active","effective_at","expires_at","version");--> statement-breakpoint
ALTER TABLE "entitlement_definitions" ADD CONSTRAINT "entitlement_definitions_key_kind_unique" UNIQUE("key","kind");--> statement-breakpoint
ALTER TABLE "entitlement_configurations" ADD CONSTRAINT "entitlement_configurations_key_kind_fk" FOREIGN KEY ("entitlement_key","kind") REFERENCES "public"."entitlement_definitions"("key","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" ADD CONSTRAINT "entitlement_plan_benefits_key_kind_fk" FOREIGN KEY ("entitlement_key","kind") REFERENCES "public"."entitlement_definitions"("key","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ADD CONSTRAINT "entitlement_user_overrides_key_kind_fk" FOREIGN KEY ("entitlement_key","kind") REFERENCES "public"."entitlement_definitions"("key","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_configurations" ADD CONSTRAINT "entitlement_configurations_upgrade_hint_check" CHECK ("entitlement_configurations"."upgrade_hint" IS NULL OR "entitlement_configurations"."upgrade_hint" ~ '^[a-z0-9][a-z0-9._-]{0,79}$');--> statement-breakpoint
ALTER TABLE "entitlement_configurations" ADD CONSTRAINT "entitlement_configurations_quota_check" CHECK ("entitlement_configurations"."quota_limit" IS NULL OR "entitlement_configurations"."quota_limit" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_configurations" ADD CONSTRAINT "entitlement_configurations_numeric_check" CHECK ("entitlement_configurations"."numeric_value" IS NULL OR "entitlement_configurations"."numeric_value" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_configurations" ADD CONSTRAINT "entitlement_configurations_value_shape_check" CHECK (
    ("entitlement_configurations"."scope" = 'global_flag' AND "entitlement_configurations"."boolean_value" IS NULL AND "entitlement_configurations"."quota_limit" IS NULL AND "entitlement_configurations"."numeric_value" IS NULL AND "entitlement_configurations"."upgrade_hint" IS NULL)
    OR ("entitlement_configurations"."scope" = 'free_default' AND (
      ("entitlement_configurations"."kind" = 'boolean' AND "entitlement_configurations"."boolean_value" IS NOT NULL AND "entitlement_configurations"."quota_limit" IS NULL AND "entitlement_configurations"."numeric_value" IS NULL)
      OR ("entitlement_configurations"."kind" = 'quota' AND "entitlement_configurations"."boolean_value" IS NULL AND "entitlement_configurations"."numeric_value" IS NULL)
      OR ("entitlement_configurations"."kind" = 'numeric' AND "entitlement_configurations"."boolean_value" IS NULL AND "entitlement_configurations"."quota_limit" IS NULL AND "entitlement_configurations"."numeric_value" IS NOT NULL)
    ))
  );--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" ADD CONSTRAINT "entitlement_plan_benefits_upgrade_hint_check" CHECK ("entitlement_plan_benefits"."upgrade_hint" IS NULL OR "entitlement_plan_benefits"."upgrade_hint" ~ '^[a-z0-9][a-z0-9._-]{0,79}$');--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" ADD CONSTRAINT "entitlement_plan_benefits_quota_check" CHECK ("entitlement_plan_benefits"."quota_limit" IS NULL OR "entitlement_plan_benefits"."quota_limit" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" ADD CONSTRAINT "entitlement_plan_benefits_numeric_check" CHECK ("entitlement_plan_benefits"."numeric_value" IS NULL OR "entitlement_plan_benefits"."numeric_value" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_usage_counters" ADD CONSTRAINT "entitlement_usage_counters_used_check" CHECK ("entitlement_usage_counters"."used" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ADD CONSTRAINT "entitlement_usage_operations_value_check" CHECK ("entitlement_usage_operations"."value" IS NULL OR "entitlement_usage_operations"."value" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ADD CONSTRAINT "entitlement_usage_operations_upgrade_hint_check" CHECK ("entitlement_usage_operations"."upgrade_hint" IS NULL OR "entitlement_usage_operations"."upgrade_hint" ~ '^[a-z0-9][a-z0-9._-]{0,79}$');--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ADD CONSTRAINT "entitlement_usage_operations_amount_check" CHECK ("entitlement_usage_operations"."amount" BETWEEN 1 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ADD CONSTRAINT "entitlement_usage_operations_limit_check" CHECK ("entitlement_usage_operations"."limit" IS NULL OR "entitlement_usage_operations"."limit" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ADD CONSTRAINT "entitlement_usage_operations_remaining_check" CHECK ("entitlement_usage_operations"."remaining" IS NULL OR "entitlement_usage_operations"."remaining" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ADD CONSTRAINT "entitlement_usage_operations_reason_check" CHECK ("entitlement_usage_operations"."reason" IS NULL OR "entitlement_usage_operations"."reason" IN ('SAFETY_RESTRICTED', 'VERIFICATION_REQUIRED', 'FEATURE_DISABLED', 'NOT_INCLUDED', 'LIMIT_REACHED', 'CONFIGURATION_INVALID'));--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ADD CONSTRAINT "entitlement_user_overrides_upgrade_hint_check" CHECK ("entitlement_user_overrides"."upgrade_hint" IS NULL OR "entitlement_user_overrides"."upgrade_hint" ~ '^[a-z0-9][a-z0-9._-]{0,79}$');--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ADD CONSTRAINT "entitlement_user_overrides_quota_check" CHECK ("entitlement_user_overrides"."quota_limit" IS NULL OR "entitlement_user_overrides"."quota_limit" BETWEEN 0 AND 1000000);--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ADD CONSTRAINT "entitlement_user_overrides_numeric_check" CHECK ("entitlement_user_overrides"."numeric_value" IS NULL OR "entitlement_user_overrides"."numeric_value" BETWEEN 0 AND 1000000);
