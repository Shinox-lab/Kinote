-- Models and credit rates from the control plane (Kinote-SaaS: docs/superpowers/specs/2026-11-11-model-settings-design.md).
-- model_settings: the deployment's ask/router/embedding model ids and rate table; one row at most (id is always
-- true), no row or a null column = the env value. Not tenant data, so no RLS. tenant_limits/tenant_defaults gain
-- the workspace's answer model (null = the deployment's) and a credit multiplier. Hand-written, following 0042's format.
CREATE TABLE "model_settings" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("id"),
  "ask_model" text CHECK (length("ask_model") BETWEEN 1 AND 200),
  "router_model" text CHECK (length("router_model") BETWEEN 1 AND 200),
  "embedding_model" text CHECK (length("embedding_model") BETWEEN 1 AND 200),
  "credit_rates" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_limits"
  ADD COLUMN "ask_model" text CHECK (length("ask_model") BETWEEN 1 AND 200),
  ADD COLUMN "credit_multiplier" numeric(6, 3) DEFAULT 1 NOT NULL CHECK ("credit_multiplier" BETWEEN 0 AND 10);
--> statement-breakpoint
ALTER TABLE "tenant_defaults"
  ADD COLUMN "ask_model" text CHECK (length("ask_model") BETWEEN 1 AND 200),
  ADD COLUMN "credit_multiplier" numeric(6, 3) DEFAULT 1 NOT NULL CHECK ("credit_multiplier" BETWEEN 0 AND 10);
