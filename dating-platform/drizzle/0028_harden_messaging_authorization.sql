SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM conversation_members cm
    JOIN conversations c ON c.id = cm.conversation_id
    WHERE cm.user_id <> c.low_user_id AND cm.user_id <> c.high_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'messaging preflight: invalid conversation member';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN conversation_members cm
      ON cm.conversation_id = m.conversation_id AND cm.user_id = m.sender_user_id
    WHERE (m.sender_user_id <> c.low_user_id AND m.sender_user_id <> c.high_user_id)
      OR cm.user_id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'messaging preflight: invalid message sender';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM message_receipts mr
    JOIN messages m ON m.id = mr.message_id
    LEFT JOIN conversation_members cm
      ON cm.conversation_id = m.conversation_id AND cm.user_id = mr.user_id
    WHERE cm.user_id IS NULL
      OR (mr.read_at IS NOT NULL AND (mr.delivered_at IS NULL OR mr.read_at < mr.delivered_at))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'messaging preflight: invalid message receipt';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "message_receipts" DROP CONSTRAINT "message_receipts_order_check";--> statement-breakpoint
ALTER TABLE "conversation_members" DROP CONSTRAINT "conversation_members_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_low_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_high_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "message_receipts" DROP CONSTRAINT "message_receipts_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "low_user_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "high_user_id" uuid;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "low_user_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "high_user_id" uuid;--> statement-breakpoint
UPDATE conversation_members cm
SET low_user_id = c.low_user_id, high_user_id = c.high_user_id
FROM conversations c
WHERE c.id = cm.conversation_id;--> statement-breakpoint
UPDATE messages m
SET low_user_id = c.low_user_id, high_user_id = c.high_user_id
FROM conversations c
WHERE c.id = m.conversation_id;--> statement-breakpoint
UPDATE message_receipts mr
SET conversation_id = m.conversation_id
FROM messages m
WHERE m.id = mr.message_id;--> statement-breakpoint
ALTER TABLE "conversation_members" ALTER COLUMN "low_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_members" ALTER COLUMN "high_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_receipts" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "low_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "high_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_identity_pair_unique" UNIQUE("id","low_user_id","high_user_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_identity_conversation_unique" UNIQUE("id","conversation_id");--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_pair_fk" FOREIGN KEY ("conversation_id","low_user_id","high_user_id") REFERENCES "public"."conversations"("id","low_user_id","high_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_low_user_id_users_id_fk" FOREIGN KEY ("low_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_high_user_id_users_id_fk" FOREIGN KEY ("high_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_conversation_fk" FOREIGN KEY ("message_id","conversation_id") REFERENCES "public"."messages"("id","conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_member_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversation_members"("conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_pair_fk" FOREIGN KEY ("conversation_id","low_user_id","high_user_id") REFERENCES "public"."conversations"("id","low_user_id","high_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_member_fk" FOREIGN KEY ("conversation_id","sender_user_id") REFERENCES "public"."conversation_members"("conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_in_pair_check" CHECK ("conversation_members"."user_id" IN ("conversation_members"."low_user_id", "conversation_members"."high_user_id"));--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_order_check" CHECK ("message_receipts"."read_at" IS NULL OR ("message_receipts"."delivered_at" IS NOT NULL AND "message_receipts"."read_at" >= "message_receipts"."delivered_at"));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_in_pair_check" CHECK ("messages"."sender_user_id" IN ("messages"."low_user_id", "messages"."high_user_id"));--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
RESET lock_timeout;
