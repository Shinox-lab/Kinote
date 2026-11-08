-- Defaults for new workspaces, pushed by the control plane (Kinote-SaaS sub-project 6:
-- docs/superpowers/specs/2026-11-08-public-signup-design.md in Kinote-SaaS). No row = no defaults:
-- new workspaces are unlimited, as before. One row at most (id is always true). Not tenant data, so no RLS;
-- kinote_app gets table privileges from 0004's default privileges. Hand-written, following 0041's format.
CREATE TABLE "tenant_defaults" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("id"),
  "plan" text NOT NULL CHECK (lower(trim("plan")) <> 'demo'),
  "seats" integer CHECK ("seats" >= 0),
  "storage_bytes" bigint CHECK ("storage_bytes" >= 0),
  "credits_per_month" integer CHECK ("credits_per_month" >= 0),
  "index_credits_per_month" integer CHECK ("index_credits_per_month" >= 0),
  "grace_percent" integer DEFAULT 10 NOT NULL CHECK ("grace_percent" BETWEEN 0 AND 100),
  "max_free_per_owner" integer CHECK ("max_free_per_owner" >= 0),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- How many live workspaces a person owns on a plan (reads across tenants, so SECURITY DEFINER).
CREATE FUNCTION public.count_owned_on_plan(p_user uuid, p_plan text)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int
  FROM public.memberships m
  JOIN public.tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user AND m.role = 'owner' AND t.deleted_at IS NULL AND t.plan = p_plan;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.count_owned_on_plan(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.count_owned_on_plan(uuid, text) TO kinote_app;
