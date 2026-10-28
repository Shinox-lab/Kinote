ALTER TABLE "captures" ADD COLUMN "file_id" uuid;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "file_text" text;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_file_id_documents_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;