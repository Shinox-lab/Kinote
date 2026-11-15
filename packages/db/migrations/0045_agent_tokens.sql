-- Agent tokens for the MCP endpoint (Kinote MCP Design Spec, "Agents and tokens"): a name and the first 8
-- characters of the secret so an admin can tell tokens apart, the user who issued it, the allowed scopes,
-- and a unique (tenant, hash) index for sign-in lookups. Agents gain an optional daily AI action limit.
-- Hand-written, following 0044's format.
ALTER TABLE "agent_tokens" ADD COLUMN "name" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "token_prefix" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "created_by" uuid;
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_scopes_check" CHECK (cardinality("scopes") > 0 AND "scopes" <@ ARRAY['read','capture','edit']::text[]);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tokens_tenant_hash_idx" ON "agent_tokens" ("tenant_id", "token_hash");
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "daily_ai_limit" integer;
