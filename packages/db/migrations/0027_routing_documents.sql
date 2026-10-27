ALTER TABLE "capture_changes" ALTER COLUMN "fact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "shape_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "shape" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "document_title" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "document_page_id" uuid;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "document_outcome" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "document_reason" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "document_options" jsonb;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "document_parent_choice" uuid;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "document_space_choice" uuid;--> statement-breakpoint
ALTER TABLE "routing_examples" ADD COLUMN "kind" text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_document_page_id_documents_id_fk" FOREIGN KEY ("document_page_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;