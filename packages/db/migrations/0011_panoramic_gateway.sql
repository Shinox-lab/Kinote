ALTER TABLE "versions" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "source_revision" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "extracted_key" text;--> statement-breakpoint
CREATE INDEX "versions_tenant_hash_idx" ON "versions" USING btree ("tenant_id","content_hash");