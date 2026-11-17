-- Whole-file capture over MCP through the Kinote file panel (an MCP App): the panel uploads the person's file in
-- 1 MiB base64 chunks through app-only tools; a row tracks one upload until it is finished, cancelled or expired
-- (1 hour). The chunks are objects under uploads/<id>/<index> in the tenant's storage. Hand-written.
CREATE TABLE "mcp_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "size" bigint NOT NULL CHECK ("size" > 0),
  "received_bytes" bigint DEFAULT 0 NOT NULL,
  "next_index" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mcp_uploads_tenant_agent_idx" ON "mcp_uploads" ("tenant_id", "agent_id");
--> statement-breakpoint
ALTER TABLE public.mcp_uploads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_uploads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_policy ON public.mcp_uploads
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
