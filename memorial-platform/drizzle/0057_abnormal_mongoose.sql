ALTER TABLE "family_people" ADD COLUMN "import_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "family_people_import_key" ON "family_people" USING btree ("import_key");