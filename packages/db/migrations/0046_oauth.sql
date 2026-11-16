-- Browser sign-in for MCP clients (Kinote MCP Design Spec, "How clients connect", second phase): Kinote is its own
-- OAuth 2.1 authorization server. Clients register themselves (RFC 7591), a member approves one in the console, and
-- the code exchange creates an agent owned by that member with an ordinary agent token. Hand-written, following 0045.
-- oauth_clients: public clients only (PKCE, no secret). Global like sessions: a client is registered before anyone
-- picks a workspace, and it holds no tenant data.
CREATE TABLE "oauth_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "redirect_uris" text[] NOT NULL CHECK (cardinality("redirect_uris") BETWEEN 1 AND 10),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One-time authorization codes (10 minutes). Only the SHA-256 is kept. The agent's name and spaces wait here until
-- the exchange, so an abandoned sign-in leaves no agent behind.
CREATE TABLE "oauth_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "code_hash" text NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "scopes" text[] NOT NULL,
  "agent_name" text NOT NULL,
  "space_ids" uuid[] NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "token_id" uuid REFERENCES "agent_tokens"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_codes_tenant_hash_idx" ON "oauth_codes" ("tenant_id", "code_hash");
--> statement-breakpoint
ALTER TABLE public.oauth_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.oauth_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_policy ON public.oauth_codes
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
--> statement-breakpoint
-- A signed-in client's token also carries a refresh token (only its SHA-256), rotated on every refresh. Revoking the
-- token on the Agents page ends both.
ALTER TABLE "agent_tokens" ADD COLUMN "refresh_token_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "refresh_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "oauth_client_id" uuid REFERENCES "oauth_clients"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tokens_tenant_refresh_idx" ON "agent_tokens" ("tenant_id", "refresh_token_hash") WHERE "refresh_token_hash" IS NOT NULL;
