-- Custom SQL migration: resetting and deleting a demo workspace.
--
-- A workspace that has had the demo content added (Settings -> Spaces) is
-- marked plan = 'demo'. wipe_demo_workspace empties it: every row of the
-- tenant goes, and the demo's colleagues (users with an @demo.example address
-- and no usable password) are removed altogether, with their sessions.
--   reset_demo_workspace  keeps the tenant, its Inbox and the memberships of
--                         real people: back to how a new workspace starts, so
--                         the demo can be added again.
--   purge_demo_workspace  keeps nothing, not even the tenant row (deleting a
--                         demo workspace; an ordinary one is only marked
--                         deleted_at by the api).
--
-- The tables reference each other in every direction, so the deletes run with
-- the foreign-key triggers off (session_replication_role = replica), which only
-- a superuser may set: hence SECURITY DEFINER, running as the migration owner.
-- Both only act on the caller's own tenant (current_tenant_id(), set by
-- withTenantTx) and only on one marked as a demo, so they can never empty an
-- ordinary workspace. EXECUTE on the two wrappers is granted to kinote_app.
CREATE OR REPLACE FUNCTION public.wipe_demo_workspace(p_tenant uuid, p_purge boolean)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_colleagues uuid[];
  v_table text;
BEGIN
  IF p_tenant IS DISTINCT FROM public.current_tenant_id() THEN
    RAISE EXCEPTION 'wipe_demo_workspace: not the current tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant AND plan = 'demo') THEN
    RAISE EXCEPTION 'wipe_demo_workspace: not a demo workspace';
  END IF;

  SELECT coalesce(array_agg(u.id), '{}') INTO v_colleagues
  FROM public.memberships m JOIN public.users u ON u.id = m.user_id
  WHERE m.tenant_id = p_tenant AND u.email LIKE '%@demo.example' AND u.password_hash = '!';

  PERFORM set_config('session_replication_role', 'replica', true);
  FOR v_table IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
      AND (p_purge OR c.table_name NOT IN ('memberships', 'spaces'))
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE tenant_id = $1', v_table) USING p_tenant;
  END LOOP;
  IF p_purge THEN
    DELETE FROM public.tenants WHERE id = p_tenant;
  ELSE
    DELETE FROM public.spaces WHERE tenant_id = p_tenant AND kind <> 'inbox';
    DELETE FROM public.memberships WHERE tenant_id = p_tenant AND user_id = ANY(v_colleagues);
  END IF;
  DELETE FROM public.sessions WHERE user_id = ANY(v_colleagues);
  DELETE FROM public.users WHERE id = ANY(v_colleagues);
  PERFORM set_config('session_replication_role', 'origin', true);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.wipe_demo_workspace(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.reset_demo_workspace(p_tenant uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT public.wipe_demo_workspace(p_tenant, false) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.purge_demo_workspace(p_tenant uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT public.wipe_demo_workspace(p_tenant, true) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reset_demo_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_demo_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reset_demo_workspace(uuid) TO kinote_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_demo_workspace(uuid) TO kinote_app;
