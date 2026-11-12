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

--> statement-breakpoint
-- A model change re-indexes and rebuilds placement for every workspace: SECURITY DEFINER like cp_list_tenants.
-- Jobs carry `operator: true`: charged 0 and never held at a workspace's indexing limit. Re-index: every live
-- indexed document with a chunk from another embedding model. Placement: what enqueuePlacementRebuild queues.
CREATE FUNCTION public.cp_queue_model_rebuild(p_embedding_model text, p_reindex boolean, p_placement boolean)
RETURNS TABLE (reindex_jobs int, placement_jobs int)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_reindex int := 0;
  n_placement int := 0;
BEGIN
  IF p_reindex THEN
    WITH stale AS (
      SELECT d.tenant_id, d.id
        FROM public.documents d
       WHERE d.indexed_version_id IS NOT NULL
         AND d.archived_at IS NULL
         AND EXISTS (
           SELECT 1 FROM public.chunks c
            WHERE c.tenant_id = d.tenant_id AND c.document_id = d.id AND c.embedding_model <> p_embedding_model
         )
    ),
    queued AS (
      INSERT INTO public.jobs (tenant_id, queue, idempotency_key, payload, status, attempts, max_attempts, run_at)
      SELECT tenant_id, 'document.reindex', 'reindex:' || id, jsonb_build_object('documentId', id, 'operator', true), 'queued', 0, 5, now()
        FROM stale
      ON CONFLICT (tenant_id, queue, idempotency_key) DO UPDATE SET
        payload = EXCLUDED.payload,
        status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'queued' END,
        rerun_requested = jobs.status = 'running',
        attempts = 0,
        last_error = NULL,
        run_at = EXCLUDED.run_at,
        max_attempts = EXCLUDED.max_attempts
      RETURNING 1
    )
    SELECT count(*)::int INTO n_reindex FROM queued;
  END IF;
  IF p_placement THEN
    WITH indexed AS (
      SELECT d.tenant_id, d.indexed_version_id AS version_id, d.kind
        FROM public.documents d
        JOIN public.spaces s ON s.tenant_id = d.tenant_id AND s.id = d.space_id
       WHERE d.indexed_version_id IS NOT NULL
         AND d.archived_at IS NULL
         AND s.kind <> 'inbox'
    ),
    wanted AS (
      SELECT tenant_id, 'version.card' AS queue, 'card:' || version_id AS idempotency_key, version_id
        FROM indexed WHERE kind = 'page'
      UNION ALL
      SELECT tenant_id, 'version.entities', 'entities:' || version_id, version_id
        FROM indexed
    ),
    queued AS (
      INSERT INTO public.jobs (tenant_id, queue, idempotency_key, payload, status, attempts, max_attempts, run_at)
      SELECT tenant_id, queue, idempotency_key, jsonb_build_object('versionId', version_id, 'operator', true), 'queued', 0, 5, now()
        FROM wanted
      ON CONFLICT (tenant_id, queue, idempotency_key) DO UPDATE SET
        payload = EXCLUDED.payload,
        status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'queued' END,
        rerun_requested = jobs.status = 'running',
        attempts = 0,
        last_error = NULL,
        run_at = EXCLUDED.run_at,
        max_attempts = EXCLUDED.max_attempts
      RETURNING 1
    )
    SELECT count(*)::int INTO n_placement FROM queued;
  END IF;
  RETURN QUERY SELECT n_reindex, n_placement;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cp_queue_model_rebuild(text, boolean, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cp_queue_model_rebuild(text, boolean, boolean) TO kinote_app;
--> statement-breakpoint
-- Operator jobs not yet done, across workspaces (the control plane shows the count while a re-index runs).
CREATE FUNCTION public.cp_model_jobs_pending()
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int FROM public.jobs j
   WHERE j.status IN ('queued', 'running') AND j.payload->>'operator' = 'true';
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cp_model_jobs_pending() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cp_model_jobs_pending() TO kinote_app;
