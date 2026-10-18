-- Create non-superuser role for api, collab, and worker
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'living_wiki_app') THEN
    CREATE ROLE living_wiki_app NOINHERIT LOGIN PASSWORD 'app_secret';
  END IF;
END
$$;

-- Helper function that fails closed (returns NULL -> false in equality) if app.tenant_id is unset
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE SQL STABLE;

-- Apply RLS to all Slice 0 tenant-scoped tables
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'memberships', 'invitations', 'agents', 'agent_tokens',
    'groups', 'group_members', 'spaces', 'space_grants',
    'audit_events', 'jobs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I
       USING (tenant_id = current_tenant_id())
       WITH CHECK (tenant_id = current_tenant_id());',
      tbl
    );
  END LOOP;
END
$$;

-- The api/collab/worker services must connect as the living_wiki_app role
-- (e.g. via SET ROLE) so that the RLS policies above apply.
GRANT USAGE ON SCHEMA public TO living_wiki_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO living_wiki_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO living_wiki_app;

-- Tenants table policy: only visible when matching current_tenant_id()
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_policy ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());
