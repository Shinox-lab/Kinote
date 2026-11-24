-- An agent's upload link for kinote_replace is staged like a panel upload, for one file. Its size is known
-- only once the PUT arrives, so only a panel upload must declare one up front. Hand-written.
ALTER TABLE "mcp_uploads" ADD COLUMN "purpose" text DEFAULT 'panel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_uploads" ADD COLUMN "document_id" uuid REFERENCES "documents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_uploads" DROP CONSTRAINT "mcp_uploads_size_check";
--> statement-breakpoint
ALTER TABLE "mcp_uploads" ADD CONSTRAINT "mcp_uploads_size_check" CHECK ("size" > 0 OR "purpose" = 'replace');
