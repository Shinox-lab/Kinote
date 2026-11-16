-- The MCP capture path (Kinote MCP Design Spec, build step 3) and capture tuning: a capture can be previewed
-- (its plan stored, nothing changed until applied), records what became of an attached file and the sender's
-- filing hint, and is found again by its source. Agents are always reviewed unless switched off (on for new
-- agents, off for existing ones); a workspace setting lets agents answer routing questions. Hand-written.
ALTER TABLE "captures" ADD COLUMN "preview" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "preview_plan" jsonb;
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "file_mode" text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "file_outcome" text;
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "file_reason" text;
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "filing_hint" text;
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "file_decision" jsonb;
--> statement-breakpoint
CREATE INDEX "captures_source_idx" ON "captures" ("tenant_id", "sender_type", "sender_id", "source_ref") WHERE "source_ref" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "always_review" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "always_review" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "agents_may_answer" boolean NOT NULL DEFAULT false;
