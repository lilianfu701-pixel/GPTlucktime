SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "entitlement_plan_benefits"
    WHERE "plan_ref" !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
  ) THEN
    RAISE EXCEPTION 'entitlement plan reference hardening preflight failed';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" DROP CONSTRAINT "entitlement_plan_benefits_plan_ref_check";--> statement-breakpoint
ALTER TABLE "entitlement_plan_benefits" ADD CONSTRAINT "entitlement_plan_benefits_plan_ref_check" CHECK ("entitlement_plan_benefits"."plan_ref" ~ '^[a-z0-9][a-z0-9._-]{0,79}$');
