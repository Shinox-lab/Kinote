-- Custom SQL migration: worker tenant discovery.
--
-- jobs has FORCE ROW LEVEL SECURITY scoped to one tenant, so a worker with no
-- tenant context sees no rows and cannot find which tenants have work. This
-- SECURITY DEFINER function runs as the migration owner and returns only the
-- distinct tenant ids (never job rows or payloads) that have a due job: queued
-- and past run_at, or running with a lease that has expired (locked_at older
-- than p_lease_seconds, i.e. a crashed worker). The worker then processes each
-- tenant inside withTenantTx. search_path is pinned and tables are
-- schema-qualified so a caller cannot shadow them. This migration runs after
-- 0004_grants, so kinote_app already exists and the grant is safe here.
CREATE OR REPLACE FUNCTION public.tenants_with_due_jobs(p_now timestamptz, p_lease_seconds int)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT j.tenant_id
  FROM public.jobs j
  WHERE (j.status = 'queued' AND j.run_at <= p_now)
     OR (j.status = 'running'
         AND j.locked_at < p_now - make_interval(secs => p_lease_seconds));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenants_with_due_jobs(timestamptz, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.tenants_with_due_jobs(timestamptz, int) TO kinote_app;
