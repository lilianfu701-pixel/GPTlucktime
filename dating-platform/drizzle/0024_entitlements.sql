SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "entitlement_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entitlement_key" varchar(80) NOT NULL,
	"scope" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"boolean_value" boolean,
	"quota_limit" integer,
	"numeric_value" double precision,
	"upgrade_hint" varchar(80),
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_configurations_key_scope_version_unique" UNIQUE("entitlement_key","scope","version"),
	CONSTRAINT "entitlement_configurations_scope_check" CHECK ("entitlement_configurations"."scope" IN ('global_flag', 'free_default')),
	CONSTRAINT "entitlement_configurations_version_check" CHECK ("entitlement_configurations"."version" > 0),
	CONSTRAINT "entitlement_configurations_kind_check" CHECK ("entitlement_configurations"."kind" IN ('boolean', 'quota', 'numeric')),
	CONSTRAINT "entitlement_configurations_quota_check" CHECK ("entitlement_configurations"."quota_limit" IS NULL OR "entitlement_configurations"."quota_limit" >= 0),
	CONSTRAINT "entitlement_configurations_numeric_check" CHECK ("entitlement_configurations"."numeric_value" IS NULL OR "entitlement_configurations"."numeric_value" >= 0),
	CONSTRAINT "entitlement_configurations_window_check" CHECK ("entitlement_configurations"."expires_at" IS NULL OR "entitlement_configurations"."expires_at" > "entitlement_configurations"."effective_at"),
	CONSTRAINT "entitlement_configurations_value_shape_check" CHECK (
    ("entitlement_configurations"."scope" = 'global_flag' AND "entitlement_configurations"."boolean_value" IS NULL AND "entitlement_configurations"."quota_limit" IS NULL AND "entitlement_configurations"."numeric_value" IS NULL)
    OR ("entitlement_configurations"."scope" = 'free_default' AND (
      ("entitlement_configurations"."kind" = 'boolean' AND "entitlement_configurations"."boolean_value" IS NOT NULL AND "entitlement_configurations"."quota_limit" IS NULL AND "entitlement_configurations"."numeric_value" IS NULL)
      OR ("entitlement_configurations"."kind" = 'quota' AND "entitlement_configurations"."boolean_value" IS NULL AND "entitlement_configurations"."numeric_value" IS NULL)
      OR ("entitlement_configurations"."kind" = 'numeric' AND "entitlement_configurations"."boolean_value" IS NULL AND "entitlement_configurations"."quota_limit" IS NULL AND "entitlement_configurations"."numeric_value" IS NOT NULL)
    ))
  )
);
--> statement-breakpoint
CREATE TABLE "entitlement_definitions" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"reset_period" text DEFAULT 'none' NOT NULL,
	"public_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_definitions_kind_check" CHECK ("entitlement_definitions"."kind" IN ('boolean', 'quota', 'numeric')),
	CONSTRAINT "entitlement_definitions_period_check" CHECK ("entitlement_definitions"."reset_period" IN ('none', 'daily', 'monthly')),
	CONSTRAINT "entitlement_definitions_period_kind_check" CHECK (
    ("entitlement_definitions"."kind" = 'quota' AND "entitlement_definitions"."reset_period" IN ('daily', 'monthly'))
    OR ("entitlement_definitions"."kind" <> 'quota' AND "entitlement_definitions"."reset_period" = 'none')
  )
);
--> statement-breakpoint
CREATE TABLE "entitlement_plan_benefits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_ref" varchar(80) NOT NULL,
	"entitlement_key" varchar(80) NOT NULL,
	"version" integer NOT NULL,
	"kind" text DEFAULT 'quota' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"boolean_value" boolean,
	"quota_limit" integer,
	"numeric_value" double precision,
	"upgrade_hint" varchar(80),
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_plan_benefits_plan_key_version_unique" UNIQUE("plan_ref","entitlement_key","version"),
	CONSTRAINT "entitlement_plan_benefits_plan_ref_check" CHECK (length("entitlement_plan_benefits"."plan_ref") BETWEEN 1 AND 80),
	CONSTRAINT "entitlement_plan_benefits_version_check" CHECK ("entitlement_plan_benefits"."version" > 0),
	CONSTRAINT "entitlement_plan_benefits_kind_check" CHECK ("entitlement_plan_benefits"."kind" IN ('boolean', 'quota', 'numeric')),
	CONSTRAINT "entitlement_plan_benefits_quota_check" CHECK ("entitlement_plan_benefits"."quota_limit" IS NULL OR "entitlement_plan_benefits"."quota_limit" >= 0),
	CONSTRAINT "entitlement_plan_benefits_numeric_check" CHECK ("entitlement_plan_benefits"."numeric_value" IS NULL OR "entitlement_plan_benefits"."numeric_value" >= 0),
	CONSTRAINT "entitlement_plan_benefits_window_check" CHECK ("entitlement_plan_benefits"."expires_at" IS NULL OR "entitlement_plan_benefits"."expires_at" > "entitlement_plan_benefits"."effective_at"),
	CONSTRAINT "entitlement_plan_benefits_value_shape_check" CHECK (
    ("entitlement_plan_benefits"."kind" = 'boolean' AND "entitlement_plan_benefits"."boolean_value" IS NOT NULL AND "entitlement_plan_benefits"."quota_limit" IS NULL AND "entitlement_plan_benefits"."numeric_value" IS NULL)
    OR ("entitlement_plan_benefits"."kind" = 'quota' AND "entitlement_plan_benefits"."boolean_value" IS NULL AND "entitlement_plan_benefits"."numeric_value" IS NULL)
    OR ("entitlement_plan_benefits"."kind" = 'numeric' AND "entitlement_plan_benefits"."boolean_value" IS NULL AND "entitlement_plan_benefits"."quota_limit" IS NULL AND "entitlement_plan_benefits"."numeric_value" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "entitlement_usage_counters" (
	"user_id" uuid NOT NULL,
	"entitlement_key" varchar(80) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_usage_counters_pk" PRIMARY KEY("user_id","entitlement_key","period_start"),
	CONSTRAINT "entitlement_usage_counters_used_check" CHECK ("entitlement_usage_counters"."used" >= 0),
	CONSTRAINT "entitlement_usage_counters_version_check" CHECK ("entitlement_usage_counters"."version" > 0),
	CONSTRAINT "entitlement_usage_counters_window_check" CHECK ("entitlement_usage_counters"."reset_at" > "entitlement_usage_counters"."period_start")
);
--> statement-breakpoint
CREATE TABLE "entitlement_usage_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entitlement_key" varchar(80) NOT NULL,
	"context_hash" varchar(64) NOT NULL,
	"amount" integer NOT NULL,
	"kind" text NOT NULL,
	"allowed" boolean NOT NULL,
	"value" double precision,
	"limit" integer,
	"remaining" integer,
	"reset_at" timestamp with time zone,
	"reason" text,
	"upgrade_hint" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_usage_operations_amount_check" CHECK ("entitlement_usage_operations"."amount" > 0),
	CONSTRAINT "entitlement_usage_operations_kind_check" CHECK ("entitlement_usage_operations"."kind" IN ('boolean', 'quota', 'numeric')),
	CONSTRAINT "entitlement_usage_operations_limit_check" CHECK ("entitlement_usage_operations"."limit" IS NULL OR "entitlement_usage_operations"."limit" >= 0),
	CONSTRAINT "entitlement_usage_operations_remaining_check" CHECK ("entitlement_usage_operations"."remaining" IS NULL OR "entitlement_usage_operations"."remaining" >= 0),
	CONSTRAINT "entitlement_usage_operations_reason_check" CHECK ("entitlement_usage_operations"."reason" IS NULL OR "entitlement_usage_operations"."reason" IN ('SAFETY_RESTRICTED', 'VERIFICATION_REQUIRED', 'FEATURE_DISABLED', 'NOT_INCLUDED', 'LIMIT_REACHED'))
);
--> statement-breakpoint
CREATE TABLE "entitlement_user_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entitlement_key" varchar(80) NOT NULL,
	"version" integer NOT NULL,
	"kind" text DEFAULT 'quota' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"boolean_value" boolean,
	"quota_limit" integer,
	"numeric_value" double precision,
	"upgrade_hint" varchar(80),
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_user_overrides_user_key_version_unique" UNIQUE("user_id","entitlement_key","version"),
	CONSTRAINT "entitlement_user_overrides_version_check" CHECK ("entitlement_user_overrides"."version" > 0),
	CONSTRAINT "entitlement_user_overrides_kind_check" CHECK ("entitlement_user_overrides"."kind" IN ('boolean', 'quota', 'numeric')),
	CONSTRAINT "entitlement_user_overrides_quota_check" CHECK ("entitlement_user_overrides"."quota_limit" IS NULL OR "entitlement_user_overrides"."quota_limit" >= 0),
	CONSTRAINT "entitlement_user_overrides_numeric_check" CHECK ("entitlement_user_overrides"."numeric_value" IS NULL OR "entitlement_user_overrides"."numeric_value" >= 0),
	CONSTRAINT "entitlement_user_overrides_window_check" CHECK ("entitlement_user_overrides"."expires_at" IS NULL OR "entitlement_user_overrides"."expires_at" > "entitlement_user_overrides"."effective_at"),
	CONSTRAINT "entitlement_user_overrides_value_shape_check" CHECK (
    ("entitlement_user_overrides"."kind" = 'boolean' AND "entitlement_user_overrides"."boolean_value" IS NOT NULL AND "entitlement_user_overrides"."quota_limit" IS NULL AND "entitlement_user_overrides"."numeric_value" IS NULL)
    OR ("entitlement_user_overrides"."kind" = 'quota' AND "entitlement_user_overrides"."boolean_value" IS NULL AND "entitlement_user_overrides"."numeric_value" IS NULL)
    OR ("entitlement_user_overrides"."kind" = 'numeric' AND "entitlement_user_overrides"."boolean_value" IS NULL AND "entitlement_user_overrides"."quota_limit" IS NULL AND "entitlement_user_overrides"."numeric_value" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "entitlement_configurations" ADD CONSTRAINT "entitlement_configurations_entitlement_key_entitlement_definitions_key_fk" FOREIGN KEY ("entitlement_key") REFERENCES "public"."entitlement_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" ADD CONSTRAINT "entitlement_plan_benefits_entitlement_key_entitlement_definitions_key_fk" FOREIGN KEY ("entitlement_key") REFERENCES "public"."entitlement_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_usage_counters" ADD CONSTRAINT "entitlement_usage_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_usage_counters" ADD CONSTRAINT "entitlement_usage_counters_entitlement_key_entitlement_definitions_key_fk" FOREIGN KEY ("entitlement_key") REFERENCES "public"."entitlement_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ADD CONSTRAINT "entitlement_usage_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_usage_operations" ADD CONSTRAINT "entitlement_usage_operations_entitlement_key_entitlement_definitions_key_fk" FOREIGN KEY ("entitlement_key") REFERENCES "public"."entitlement_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ADD CONSTRAINT "entitlement_user_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ADD CONSTRAINT "entitlement_user_overrides_entitlement_key_entitlement_definitions_key_fk" FOREIGN KEY ("entitlement_key") REFERENCES "public"."entitlement_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entitlement_configurations_resolution_idx" ON "entitlement_configurations" USING btree ("entitlement_key","scope","active","effective_at","expires_at","version");--> statement-breakpoint
CREATE INDEX "entitlement_plan_benefits_resolution_idx" ON "entitlement_plan_benefits" USING btree ("plan_ref","entitlement_key","active","effective_at","expires_at","version");--> statement-breakpoint
CREATE INDEX "entitlement_usage_counters_reset_idx" ON "entitlement_usage_counters" USING btree ("reset_at");--> statement-breakpoint
CREATE INDEX "entitlement_usage_operations_owner_created_idx" ON "entitlement_usage_operations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "entitlement_usage_operations_retention_idx" ON "entitlement_usage_operations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "entitlement_user_overrides_resolution_idx" ON "entitlement_user_overrides" USING btree ("user_id","entitlement_key","active","effective_at","expires_at","version");--> statement-breakpoint
INSERT INTO "entitlement_definitions" ("key", "kind", "reset_period", "public_visible") VALUES
  ('message.send.daily', 'quota', 'daily', true),
  ('message.read_receipt.view', 'boolean', 'none', true),
  ('search.advanced.use', 'boolean', 'none', true),
  ('likes.received.view', 'boolean', 'none', true),
  ('profile.visitors.view', 'boolean', 'none', true),
  ('profile.incognito.use', 'boolean', 'none', true),
  ('translation.message.use', 'quota', 'monthly', true),
  ('ranking.boost.multiplier', 'numeric', 'none', true),
  ('super_like.monthly', 'quota', 'monthly', true)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Version 1 is inserted only when absent. A deploy never overwrites a later
-- operator version or silently reactivates an expired/disabled configuration.
INSERT INTO "entitlement_configurations"
  ("id", "entitlement_key", "scope", "version", "kind", "enabled", "boolean_value", "quota_limit", "numeric_value", "upgrade_hint", "effective_at")
VALUES
  ('00000000-0000-4000-8000-000000000101', 'message.send.daily', 'free_default', 1, 'quota', true, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000102', 'message.read_receipt.view', 'free_default', 1, 'boolean', true, true, NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000103', 'search.advanced.use', 'free_default', 1, 'boolean', true, true, NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000104', 'likes.received.view', 'free_default', 1, 'boolean', true, true, NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000105', 'profile.visitors.view', 'free_default', 1, 'boolean', true, true, NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000106', 'profile.incognito.use', 'free_default', 1, 'boolean', true, true, NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000107', 'translation.message.use', 'free_default', 1, 'quota', true, NULL, 0, NULL, 'membership', '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000108', 'ranking.boost.multiplier', 'free_default', 1, 'numeric', true, NULL, NULL, 1.0, NULL, '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000109', 'super_like.monthly', 'free_default', 1, 'quota', true, NULL, 0, NULL, 'membership', '2026-01-01T00:00:00Z')
ON CONFLICT ("entitlement_key", "scope", "version") DO NOTHING;
