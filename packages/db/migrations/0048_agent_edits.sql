-- The MCP edit path (Kinote MCP Design Spec, build step 4): a suggestion records who proposed it, so an agent's
-- kinote_edit suggestion is named on its card, accepted as that agent, and never decided by the agent's owner in
-- a review space. Capture suggestions keep capture_id and leave these null. Hand-written.
ALTER TABLE "suggestions" ADD COLUMN "proposed_by_type" text;
--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "proposed_by" uuid;
--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_proposed_by_type_check" CHECK ("proposed_by_type" IN ('user', 'agent'));
