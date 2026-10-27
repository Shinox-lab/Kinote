CREATE INDEX "documents_title_trgm_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "links_to_document_idx" ON "links" USING btree ("tenant_id","to_document_id");--> statement-breakpoint
CREATE INDEX "links_from_page_idx" ON "links" USING btree ("tenant_id","from_page_id");