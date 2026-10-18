-- Lists every live tenant a user belongs to, with their role, across tenants.
-- tenants and memberships have FORCE ROW LEVEL SECURITY scoped to one tenant,
-- so this is SECURITY DEFINER: it runs as the migration owner (a superuser /
-- BYPASSRLS role), which is the only way to read across tenants. It takes the
-- user id as an argument and returns only that user's rows; callers must pass
-- the id of the authenticated session user, never a client-supplied id.
CREATE OR REPLACE FUNCTION my_tenants(p_user uuid)
RETURNS TABLE (tenant_id uuid, name text, slug text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.name, t.slug, m.role
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user
    AND t.deleted_at IS NULL
  ORDER BY t.name, t.id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION my_tenants(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION my_tenants(uuid) TO living_wiki_app;
