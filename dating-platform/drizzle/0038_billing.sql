CREATE TABLE "billing_customers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"provider_customer_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_provider_mapping_unique" UNIQUE("provider","provider_customer_id"),
	CONSTRAINT "billing_customers_user_provider_unique" UNIQUE("user_id","provider_customer_id"),
	CONSTRAINT "billing_customers_provider_check" CHECK ("billing_customers"."provider" = 'stripe')
);
--> statement-breakpoint
CREATE TABLE "billing_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid,
	"user_id" uuid NOT NULL,
	"provider_dispute_id" varchar(255) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"previous_subscription_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_disputes_provider_unique" UNIQUE("provider_dispute_id"),
	CONSTRAINT "billing_disputes_event_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "billing_disputes_amount_check" CHECK ("billing_disputes"."amount" BETWEEN 1 AND 1000000000),
	CONSTRAINT "billing_disputes_currency_check" CHECK ("billing_disputes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_disputes_status_check" CHECK ("billing_disputes"."status" IN ('needs_review', 'won', 'lost', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "billing_entitlement_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" uuid,
	"source_event_id" varchar(255) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_entitlement_outbox_source_unique" UNIQUE("source_event_id"),
	CONSTRAINT "billing_entitlement_outbox_status_check" CHECK ("billing_entitlement_outbox"."status" IN ('pending', 'leased', 'done', 'failed')),
	CONSTRAINT "billing_entitlement_outbox_attempts_check" CHECK ("billing_entitlement_outbox"."attempts" BETWEEN 0 AND 20),
	CONSTRAINT "billing_entitlement_outbox_lease_shape_check" CHECK (
    ("billing_entitlement_outbox"."status" = 'leased' AND "billing_entitlement_outbox"."lease_id" IS NOT NULL AND "billing_entitlement_outbox"."lease_expires_at" IS NOT NULL)
    OR ("billing_entitlement_outbox"."status" <> 'leased' AND "billing_entitlement_outbox"."lease_id" IS NULL AND "billing_entitlement_outbox"."lease_expires_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "billing_invoice_payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_invoice_payment_id" varchar(255) NOT NULL,
	"provider_payment_id" varchar(255),
	"provider_charge_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_invoice_payment_links_provider_unique" UNIQUE("provider_invoice_payment_id"),
	CONSTRAINT "billing_invoice_payment_links_target_check" CHECK ("billing_invoice_payment_links"."provider_payment_id" IS NOT NULL OR "billing_invoice_payment_links"."provider_charge_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "billing_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"plan_ref" varchar(80) NOT NULL,
	"plan_version" integer NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_session_id" varchar(255),
	"checkout_url" text,
	"provider_failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_orders_user_idempotency_unique" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "billing_orders_id_user_unique" UNIQUE("id","user_id"),
	CONSTRAINT "billing_orders_provider_session_unique" UNIQUE("provider_session_id"),
	CONSTRAINT "billing_orders_request_hash_check" CHECK ("billing_orders"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "billing_orders_plan_version_check" CHECK ("billing_orders"."plan_version" > 0),
	CONSTRAINT "billing_orders_amount_check" CHECK ("billing_orders"."amount" BETWEEN 0 AND 1000000000),
	CONSTRAINT "billing_orders_currency_check" CHECK ("billing_orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_orders_status_check" CHECK ("billing_orders"."status" IN ('pending', 'session_created', 'paid', 'failed', 'canceled', 'refunded', 'disputed', 'review_required')),
	CONSTRAINT "billing_orders_failure_count_check" CHECK ("billing_orders"."provider_failure_count" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "billing_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"subscription_id" uuid,
	"provider_invoice_id" varchar(255) NOT NULL,
	"provider_invoice_payment_id" varchar(255),
	"provider_payment_id" varchar(255),
	"provider_charge_id" varchar(255),
	"provider_event_id" varchar(255) NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_payments_invoice_unique" UNIQUE("provider_invoice_id"),
	CONSTRAINT "billing_payments_invoice_payment_unique" UNIQUE("provider_invoice_payment_id"),
	CONSTRAINT "billing_payments_event_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "billing_payments_amount_check" CHECK ("billing_payments"."amount" BETWEEN 0 AND 1000000000),
	CONSTRAINT "billing_payments_currency_check" CHECK ("billing_payments"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "billing_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_ref" varchar(80) NOT NULL,
	"version" integer NOT NULL,
	"name_key" varchar(120) NOT NULL,
	"description_key" varchar(120) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plans_ref_version_unique" UNIQUE("plan_ref","version"),
	CONSTRAINT "billing_plans_ref_check" CHECK ("billing_plans"."plan_ref" ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
	CONSTRAINT "billing_plans_version_check" CHECK ("billing_plans"."version" > 0),
	CONSTRAINT "billing_plans_window_check" CHECK ("billing_plans"."expires_at" IS NULL OR "billing_plans"."expires_at" > "billing_plans"."effective_at")
);
--> statement-breakpoint
CREATE TABLE "billing_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"unit_amount" bigint NOT NULL,
	"interval" text NOT NULL,
	"interval_count" integer NOT NULL,
	"tax_mode" text NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"provider_price_id" varchar(255) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_prices_plan_country_currency_version_unique" UNIQUE("plan_id","country_code","currency","version"),
	CONSTRAINT "billing_prices_provider_price_unique" UNIQUE("provider","provider_price_id"),
	CONSTRAINT "billing_prices_version_check" CHECK ("billing_prices"."version" > 0),
	CONSTRAINT "billing_prices_country_check" CHECK ("billing_prices"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "billing_prices_currency_check" CHECK ("billing_prices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_prices_amount_check" CHECK ("billing_prices"."unit_amount" BETWEEN 0 AND 1000000000),
	CONSTRAINT "billing_prices_interval_check" CHECK ("billing_prices"."interval" IN ('monthly', 'quarterly', 'yearly')),
	CONSTRAINT "billing_prices_interval_count_check" CHECK ("billing_prices"."interval_count" BETWEEN 1 AND 36),
	CONSTRAINT "billing_prices_tax_mode_check" CHECK ("billing_prices"."tax_mode" IN ('inclusive', 'exclusive')),
	CONSTRAINT "billing_prices_provider_check" CHECK ("billing_prices"."provider" = 'stripe'),
	CONSTRAINT "billing_prices_window_check" CHECK ("billing_prices"."expires_at" IS NULL OR "billing_prices"."expires_at" > "billing_prices"."effective_at")
);
--> statement-breakpoint
CREATE TABLE "billing_reconciliation_collected" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"side" text NOT NULL,
	"object_type" text NOT NULL,
	"provider_object_id" varchar(255) NOT NULL,
	"object_status" varchar(80),
	"amount" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_reconciliation_collected_dedupe_unique" UNIQUE("run_id","side","object_type","provider_object_id"),
	CONSTRAINT "billing_reconciliation_collected_side_check" CHECK ("billing_reconciliation_collected"."side" IN ('provider', 'internal')),
	CONSTRAINT "billing_reconciliation_collected_type_check" CHECK ("billing_reconciliation_collected"."object_type" IN ('subscriptions', 'invoices', 'refunds', 'disputes')),
	CONSTRAINT "billing_reconciliation_collected_amount_check" CHECK ("billing_reconciliation_collected"."amount" IS NULL OR "billing_reconciliation_collected"."amount" BETWEEN 0 AND 1000000000)
);
--> statement-breakpoint
CREATE TABLE "billing_reconciliation_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"cursor_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_reconciliation_cursors_dedupe_unique" UNIQUE("run_id","phase","cursor_hash"),
	CONSTRAINT "billing_reconciliation_cursors_phase_check" CHECK ("billing_reconciliation_cursors"."phase" IN ('provider', 'internal', 'compare')),
	CONSTRAINT "billing_reconciliation_cursors_hash_check" CHECK ("billing_reconciliation_cursors"."cursor_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "billing_reconciliation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"object_type" text NOT NULL,
	"provider_object_id" varchar(255) NOT NULL,
	"internal_fingerprint" varchar(64),
	"provider_fingerprint" varchar(64),
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_reconciliation_items_dedupe_unique" UNIQUE("run_id","kind","object_type","provider_object_id"),
	CONSTRAINT "billing_reconciliation_items_kind_check" CHECK ("billing_reconciliation_items"."kind" IN ('missing_internal', 'missing_provider', 'value_mismatch')),
	CONSTRAINT "billing_reconciliation_items_type_check" CHECK ("billing_reconciliation_items"."object_type" IN ('subscriptions', 'invoices', 'refunds', 'disputes')),
	CONSTRAINT "billing_reconciliation_items_status_check" CHECK ("billing_reconciliation_items"."status" IN ('open', 'reviewing', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "billing_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" varchar(160) NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"phase" text DEFAULT 'provider' NOT NULL,
	"cursor" varchar(2048),
	"provider_pages" integer DEFAULT 0 NOT NULL,
	"internal_pages" integer DEFAULT 0 NOT NULL,
	"compare_pages" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error_code" varchar(80),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_reconciliation_runs_key_unique" UNIQUE("run_key"),
	CONSTRAINT "billing_reconciliation_runs_status_check" CHECK ("billing_reconciliation_runs"."status" IN ('running', 'retry', 'completed', 'failed')),
	CONSTRAINT "billing_reconciliation_runs_phase_check" CHECK ("billing_reconciliation_runs"."phase" IN ('provider', 'internal', 'compare')),
	CONSTRAINT "billing_reconciliation_runs_attempts_check" CHECK ("billing_reconciliation_runs"."attempts" BETWEEN 0 AND 20),
	CONSTRAINT "billing_reconciliation_runs_progress_check" CHECK ("billing_reconciliation_runs"."provider_pages" BETWEEN 0 AND 10000 AND "billing_reconciliation_runs"."internal_pages" BETWEEN 0 AND 10000 AND "billing_reconciliation_runs"."compare_pages" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "billing_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_refund_id" varchar(255) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_refunds_provider_unique" UNIQUE("provider_refund_id"),
	CONSTRAINT "billing_refunds_event_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "billing_refunds_amount_check" CHECK ("billing_refunds"."amount" BETWEEN 1 AND 1000000000),
	CONSTRAINT "billing_refunds_currency_check" CHECK ("billing_refunds"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "billing_subscription_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscription_intents_user_idempotency_unique" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "billing_subscription_intents_hash_check" CHECK ("billing_subscription_intents"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "billing_subscription_intents_action_check" CHECK ("billing_subscription_intents"."action" IN ('cancel_at_period_end', 'resume')),
	CONSTRAINT "billing_subscription_intents_status_check" CHECK ("billing_subscription_intents"."status" IN ('pending', 'provider_submitted', 'failed')),
	CONSTRAINT "billing_subscription_intents_attempts_check" CHECK ("billing_subscription_intents"."attempts" BETWEEN 0 AND 20)
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid,
	"price_id" uuid NOT NULL,
	"plan_ref" varchar(80) NOT NULL,
	"provider_customer_id" varchar(255) NOT NULL,
	"provider_subscription_id" varchar(255) NOT NULL,
	"status" text NOT NULL,
	"provider_status" text DEFAULT 'active' NOT NULL,
	"entitlement_override" text DEFAULT 'none' NOT NULL,
	"current_entitlement_payment_id" uuid,
	"provider_object_version" bigint NOT NULL,
	"provider_event_created_at" timestamp with time zone NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_provider_unique" UNIQUE("provider_subscription_id"),
	CONSTRAINT "billing_subscriptions_order_unique" UNIQUE("order_id"),
	CONSTRAINT "billing_subscriptions_status_check" CHECK ("billing_subscriptions"."status" IN ('trialing', 'active', 'past_due', 'grace_period', 'disputed', 'revoked', 'canceled', 'expired')),
	CONSTRAINT "billing_subscriptions_provider_status_check" CHECK ("billing_subscriptions"."provider_status" IN ('trialing', 'active', 'past_due', 'grace_period', 'canceled', 'expired')),
	CONSTRAINT "billing_subscriptions_override_check" CHECK ("billing_subscriptions"."entitlement_override" IN ('none', 'dispute_open', 'dispute_lost', 'refund_full', 'duplicate_subscription')),
	CONSTRAINT "billing_subscriptions_effective_status_check" CHECK (
    ("billing_subscriptions"."entitlement_override" = 'none' AND "billing_subscriptions"."status" = "billing_subscriptions"."provider_status")
    OR ("billing_subscriptions"."entitlement_override" = 'dispute_open' AND "billing_subscriptions"."status" = 'disputed')
    OR ("billing_subscriptions"."entitlement_override" = 'dispute_lost' AND "billing_subscriptions"."status" = 'revoked')
    OR ("billing_subscriptions"."entitlement_override" = 'refund_full' AND "billing_subscriptions"."status" = 'expired')
    OR ("billing_subscriptions"."entitlement_override" = 'duplicate_subscription' AND "billing_subscriptions"."status" = 'revoked')
  ),
	CONSTRAINT "billing_subscriptions_version_check" CHECK ("billing_subscriptions"."provider_object_version" >= 0),
	CONSTRAINT "billing_subscriptions_period_check" CHECK ("billing_subscriptions"."current_period_end" IS NULL OR "billing_subscriptions"."current_period_start" IS NOT NULL AND "billing_subscriptions"."current_period_end" > "billing_subscriptions"."current_period_start"),
	CONSTRAINT "billing_subscriptions_grace_check" CHECK ("billing_subscriptions"."grace_ends_at" IS NULL OR "billing_subscriptions"."provider_status" IN ('past_due', 'grace_period'))
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"provider_event_id" varchar(255) PRIMARY KEY NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"object_id" varchar(255) NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"review_reason" varchar(180),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "billing_webhook_events_hash_check" CHECK ("billing_webhook_events"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "billing_webhook_events_outcome_check" CHECK ("billing_webhook_events"."outcome" IN ('processing', 'applied', 'stale', 'ignored'))
);
--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD CONSTRAINT "billing_disputes_payment_id_billing_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."billing_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD CONSTRAINT "billing_disputes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD CONSTRAINT "billing_disputes_provider_event_id_billing_webhook_events_provider_event_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."billing_webhook_events"("provider_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_entitlement_outbox" ADD CONSTRAINT "billing_entitlement_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_entitlement_outbox" ADD CONSTRAINT "billing_entitlement_outbox_subscription_id_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."billing_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_entitlement_outbox" ADD CONSTRAINT "billing_entitlement_outbox_source_event_id_billing_webhook_events_provider_event_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."billing_webhook_events"("provider_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_payment_links" ADD CONSTRAINT "billing_invoice_payment_links_payment_id_billing_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."billing_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_price_id_billing_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."billing_prices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_order_id_billing_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."billing_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_subscription_id_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."billing_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_provider_event_id_billing_webhook_events_provider_event_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."billing_webhook_events"("provider_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_prices" ADD CONSTRAINT "billing_prices_plan_id_billing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."billing_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_collected" ADD CONSTRAINT "billing_reconciliation_collected_run_id_billing_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."billing_reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_cursors" ADD CONSTRAINT "billing_reconciliation_cursors_run_id_billing_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."billing_reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_items" ADD CONSTRAINT "billing_reconciliation_items_run_id_billing_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."billing_reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_payment_id_billing_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."billing_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_provider_event_id_billing_webhook_events_provider_event_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."billing_webhook_events"("provider_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscription_intents" ADD CONSTRAINT "billing_subscription_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscription_intents" ADD CONSTRAINT "billing_subscription_intents_subscription_id_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."billing_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_order_id_billing_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."billing_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_price_id_billing_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."billing_prices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_current_entitlement_payment_id_billing_payments_id_fk" FOREIGN KEY ("current_entitlement_payment_id") REFERENCES "public"."billing_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_customer_owner_fk" FOREIGN KEY ("user_id","provider_customer_id") REFERENCES "public"."billing_customers"("user_id","provider_customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_order_owner_fk" FOREIGN KEY ("order_id","user_id") REFERENCES "public"."billing_orders"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_entitlement_outbox_claim_idx" ON "billing_entitlement_outbox" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "billing_invoice_payment_links_payment_idx" ON "billing_invoice_payment_links" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_invoice_payment_links_provider_payment_idx" ON "billing_invoice_payment_links" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE INDEX "billing_invoice_payment_links_provider_charge_idx" ON "billing_invoice_payment_links" USING btree ("provider_charge_id");--> statement-breakpoint
CREATE INDEX "billing_orders_owner_created_idx" ON "billing_orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_payments_provider_payment_idx" ON "billing_payments" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE INDEX "billing_payments_provider_charge_idx" ON "billing_payments" USING btree ("provider_charge_id");--> statement-breakpoint
CREATE INDEX "billing_payments_order_idx" ON "billing_payments" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_plans_public_idx" ON "billing_plans" USING btree ("active","effective_at","expires_at","plan_ref");--> statement-breakpoint
CREATE INDEX "billing_prices_selection_idx" ON "billing_prices" USING btree ("country_code","currency","active","effective_at","expires_at");--> statement-breakpoint
CREATE INDEX "billing_reconciliation_collected_run_idx" ON "billing_reconciliation_collected" USING btree ("run_id","side","object_type");--> statement-breakpoint
CREATE INDEX "billing_reconciliation_cursors_run_idx" ON "billing_reconciliation_cursors" USING btree ("run_id","phase");--> statement-breakpoint
CREATE INDEX "billing_reconciliation_items_review_idx" ON "billing_reconciliation_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "billing_reconciliation_runs_claim_idx" ON "billing_reconciliation_runs" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "billing_refunds_payment_idx" ON "billing_refunds" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_subscription_intents_retry_idx" ON "billing_subscription_intents" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_owner_status_idx" ON "billing_subscriptions" USING btree ("user_id","status","current_period_end");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_created_idx" ON "billing_webhook_events" USING btree ("provider_created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_one_current_per_user_idx" ON "billing_subscriptions" ("user_id")
  WHERE "status" IN ('trialing', 'active', 'past_due', 'grace_period', 'disputed');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION billing_reject_ledger_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'BILLING_LEDGER_APPEND_ONLY' USING ERRCODE = '23000'; END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER billing_payments_append_only BEFORE UPDATE OR DELETE ON "billing_payments"
  FOR EACH ROW EXECUTE FUNCTION billing_reject_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER billing_invoice_payment_links_append_only BEFORE UPDATE OR DELETE ON "billing_invoice_payment_links"
  FOR EACH ROW EXECUTE FUNCTION billing_reject_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER billing_refunds_append_only BEFORE UPDATE OR DELETE ON "billing_refunds"
  FOR EACH ROW EXECUTE FUNCTION billing_reject_ledger_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION billing_guard_dispute_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BILLING_DISPUTE_FACTS_IMMUTABLE' USING ERRCODE = '23000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.user_id <> OLD.user_id
    OR NEW.provider_dispute_id <> OLD.provider_dispute_id OR NEW.provider_event_id <> OLD.provider_event_id
    OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
    OR NEW.previous_subscription_status IS DISTINCT FROM OLD.previous_subscription_status THEN
    RAISE EXCEPTION 'BILLING_DISPUTE_FACTS_IMMUTABLE' USING ERRCODE = '23000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'needs_review' AND NEW.status IN ('won','lost','closed')) OR
    (OLD.status IN ('won','lost') AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'BILLING_DISPUTE_TRANSITION_INVALID' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER billing_disputes_guard BEFORE UPDATE OR DELETE ON "billing_disputes"
  FOR EACH ROW EXECUTE FUNCTION billing_guard_dispute_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION billing_validate_subscription_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.provider_object_version < OLD.provider_object_version OR NEW.provider_event_created_at < OLD.provider_event_created_at THEN
    RAISE EXCEPTION 'BILLING_SUBSCRIPTION_STALE' USING ERRCODE = '23000';
  END IF;
  IF NEW.provider_status <> OLD.provider_status AND NOT (
    (OLD.provider_status = 'trialing' AND NEW.provider_status IN ('active','past_due','grace_period','canceled','expired')) OR
    (OLD.provider_status = 'active' AND NEW.provider_status IN ('past_due','grace_period','canceled','expired')) OR
    (OLD.provider_status = 'past_due' AND NEW.provider_status IN ('active','grace_period','canceled','expired')) OR
    (OLD.provider_status = 'grace_period' AND NEW.provider_status IN ('active','past_due','canceled','expired')) OR
    (OLD.provider_status IN ('canceled','expired') AND NEW.provider_status = 'active')
  ) THEN RAISE EXCEPTION 'BILLING_SUBSCRIPTION_TRANSITION_INVALID' USING ERRCODE = '23000'; END IF;
  IF NEW.entitlement_override <> OLD.entitlement_override AND NOT (
    (OLD.entitlement_override = 'none' AND NEW.entitlement_override IN ('dispute_open','refund_full')) OR
    (OLD.entitlement_override = 'dispute_open' AND NEW.entitlement_override IN ('none','dispute_lost','refund_full')) OR
    (OLD.entitlement_override = 'dispute_lost' AND NEW.entitlement_override = 'refund_full') OR
    (OLD.entitlement_override = 'refund_full' AND NEW.entitlement_override IN ('none','dispute_lost'))
  ) THEN RAISE EXCEPTION 'BILLING_SUBSCRIPTION_OVERRIDE_TRANSITION_INVALID' USING ERRCODE = '23000'; END IF;
  IF NOT (
    (NEW.entitlement_override = 'none' AND NEW.status = NEW.provider_status) OR
    (NEW.entitlement_override = 'dispute_open' AND NEW.status = 'disputed') OR
    (NEW.entitlement_override = 'dispute_lost' AND NEW.status = 'revoked') OR
    (NEW.entitlement_override = 'refund_full' AND NEW.status = 'expired') OR
    (NEW.entitlement_override = 'duplicate_subscription' AND NEW.status = 'revoked')
  ) THEN RAISE EXCEPTION 'BILLING_SUBSCRIPTION_EFFECTIVE_STATUS_INVALID' USING ERRCODE = '23000'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER billing_subscriptions_transition_guard BEFORE UPDATE ON "billing_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION billing_validate_subscription_transition();
