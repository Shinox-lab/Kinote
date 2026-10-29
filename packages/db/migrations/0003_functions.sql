-- Custom SQL migration: functions.
--
-- my_tenants lists every live tenant a user belongs to, with their role, across
-- tenants. tenants and memberships have FORCE ROW LEVEL SECURITY scoped to one
-- tenant, so this is SECURITY DEFINER: it runs as the migration owner, which is
-- the only way to read across tenants. It takes the user id as an argument and
-- returns only that user's rows; callers must pass the id of the authenticated
-- session user, never a client-supplied id. search_path is pinned and every
-- table is schema-qualified so a caller cannot shadow them.
-- EXECUTE is granted to kinote_app in 0004_grants, after the role exists.
CREATE OR REPLACE FUNCTION public.my_tenants(p_user uuid)
RETURNS TABLE (tenant_id uuid, name text, slug text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.name, t.slug, m.role
  FROM public.memberships m
  JOIN public.tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user
    AND t.deleted_at IS NULL
  ORDER BY t.name, t.id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.my_tenants(uuid) FROM PUBLIC;
