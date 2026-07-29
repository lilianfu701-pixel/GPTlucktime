CREATE TABLE "memorial_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memorial_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "memorial_member_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memorial_invitations" ADD CONSTRAINT "memorial_invitations_memorial_id_memorials_id_fk" FOREIGN KEY ("memorial_id") REFERENCES "public"."memorials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_invitations" ADD CONSTRAINT "memorial_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorial_invitations" ADD CONSTRAINT "memorial_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memorial_invitations_token_key" ON "memorial_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "memorial_invitations_memorial_idx" ON "memorial_invitations" USING btree ("memorial_id");--> statement-breakpoint
CREATE INDEX "memorial_invitations_email_idx" ON "memorial_invitations" USING btree ("email");