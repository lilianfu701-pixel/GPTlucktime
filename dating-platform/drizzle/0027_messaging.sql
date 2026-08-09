CREATE TABLE "conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_sequence" bigint DEFAULT 0 NOT NULL,
	"hidden_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_members_pk" PRIMARY KEY("conversation_id","user_id"),
	CONSTRAINT "conversation_members_last_read_check" CHECK ("conversation_members"."last_read_sequence" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "conversation_members_version_check" CHECK ("conversation_members"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"low_user_id" uuid NOT NULL,
	"high_user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_pair_unique" UNIQUE("low_user_id","high_user_id"),
	CONSTRAINT "conversations_ordered_pair_check" CHECK ("conversations"."low_user_id" < "conversations"."high_user_id"),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" IN ('active', 'closed')),
	CONSTRAINT "conversations_next_sequence_check" CHECK ("conversations"."next_sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "conversations_version_check" CHECK ("conversations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"moderation_status" text DEFAULT 'pending_review' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "message_attachments_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "message_attachments_status_check" CHECK ("message_attachments"."moderation_status" IN ('pending_review', 'approved', 'rejected', 'quarantined'))
);
--> statement-breakpoint
CREATE TABLE "message_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"event_type" text DEFAULT 'message.created' NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_outbox_message_unique" UNIQUE("message_id"),
	CONSTRAINT "message_outbox_type_check" CHECK ("message_outbox_events"."event_type" = 'message.created'),
	CONSTRAINT "message_outbox_status_check" CHECK ("message_outbox_events"."status" IN ('pending', 'processing', 'published', 'failed')),
	CONSTRAINT "message_outbox_attempts_check" CHECK ("message_outbox_events"."attempts" >= 0),
	CONSTRAINT "message_outbox_lease_check" CHECK (
    ("message_outbox_events"."status" = 'processing' AND "message_outbox_events"."lease_id" IS NOT NULL AND "message_outbox_events"."lease_expires_at" IS NOT NULL)
    OR ("message_outbox_events"."status" <> 'processing' AND "message_outbox_events"."lease_id" IS NULL AND "message_outbox_events"."lease_expires_at" IS NULL)
  ),
	CONSTRAINT "message_outbox_publish_check" CHECK (
    ("message_outbox_events"."status" = 'published' AND "message_outbox_events"."published_at" IS NOT NULL)
    OR ("message_outbox_events"."status" <> 'published' AND "message_outbox_events"."published_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "message_receipts" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_receipts_pk" PRIMARY KEY("message_id","user_id"),
	CONSTRAINT "message_receipts_order_check" CHECK ("message_receipts"."read_at" IS NULL OR "message_receipts"."delivered_at" IS NULL OR "message_receipts"."read_at" >= "message_receipts"."delivered_at"),
	CONSTRAINT "message_receipts_version_check" CHECK ("message_receipts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_conversation_sequence_unique" UNIQUE("conversation_id","sequence"),
	CONSTRAINT "messages_sender_client_unique" UNIQUE("sender_user_id","client_id"),
	CONSTRAINT "messages_sequence_check" CHECK ("messages"."sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "messages_body_length_check" CHECK (char_length("messages"."body") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_low_user_id_users_id_fk" FOREIGN KEY ("low_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_high_user_id_users_id_fk" FOREIGN KEY ("high_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox_events" ADD CONSTRAINT "message_outbox_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_members_owner_recent_idx" ON "conversation_members" USING btree ("user_id","hidden_at","conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_low_recent_idx" ON "conversations" USING btree ("low_user_id","last_message_at","id");--> statement-breakpoint
CREATE INDEX "conversations_high_recent_idx" ON "conversations" USING btree ("high_user_id","last_message_at","id");--> statement-breakpoint
CREATE INDEX "message_attachments_review_idx" ON "message_attachments" USING btree ("moderation_status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_outbox_dedupe_unique" ON "message_outbox_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "message_outbox_claim_idx" ON "message_outbox_events" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "message_receipts_user_read_idx" ON "message_receipts" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_history_idx" ON "messages" USING btree ("conversation_id","sequence");