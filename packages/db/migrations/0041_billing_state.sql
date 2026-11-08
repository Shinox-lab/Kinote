-- Billing state set by the control plane (Kinote-SaaS sub-project 3:
-- docs/superpowers/specs/2026-11-05-billing-design.md in Kinote-SaaS). No row = 'ok'.
-- Hand-written, following 0040's format.
CREATE TABLE "tenant_billing" (
  "tenant_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."tenants"("id"),
  "state" text DEFAULT 'ok' NOT NULL CHECK ("state" IN ('ok', 'past_due', 'suspended')),
  "manage_url" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE public.tenant_billing ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tenant_billing FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_policy ON public.tenant_billing
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
--> statement-breakpoint
-- The listing gains the billing state (a changed return type needs DROP first).
DROP FUNCTION public.cp_list_tenants(uuid, int);
--> statement-breakpoint
CREATE FUNCTION public.cp_list_tenants(p_after uuid, p_limit int)
RETURNS TABLE (id uuid, slug text, name text, plan text, created_at timestamptz, deleted_at timestamptz, owner_email text, seats int, billing_state text, manage_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.slug, t.name, t.plan, t.created_at, t.deleted_at,
    (SELECT u.email FROM public.memberships m JOIN public.users u ON u.id = m.user_id
       WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at, m.user_id LIMIT 1),
    ((SELECT count(*) FROM public.memberships m WHERE m.tenant_id = t.id AND m.role <> 'viewer')
      + (SELECT count(*) FROM public.invitations i WHERE i.tenant_id = t.id AND i.role <> 'viewer'
           AND i.accepted_at IS NULL AND i.expires_at > now()))::int,
    COALESCE(b.state, 'ok'),
    b.manage_url
  FROM public.tenants t
  LEFT JOIN public.tenant_billing b ON b.tenant_id = t.id
  WHERE p_after IS NULL
     OR (t.created_at, t.id) > (SELECT a.created_at, a.id FROM public.tenants a WHERE a.id = p_after)
  ORDER BY t.created_at, t.id
  LIMIT p_limit;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cp_list_tenants(uuid, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cp_list_tenants(uuid, int) TO kinote_app;
