-- Custom data migration: build page cards and the entity graph for everything
-- already indexed. Each job is keyed exactly like the ones indexVersion
-- enqueues, so an existing row is revived instead of duplicated. Inbox
-- documents get neither (R17); files get no card.
WITH indexed AS (
  SELECT d.tenant_id, d.indexed_version_id AS version_id, d.kind
    FROM documents d
    JOIN spaces s ON s.tenant_id = d.tenant_id AND s.id = d.space_id
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
)
INSERT INTO jobs (
  tenant_id, queue, idempotency_key, payload, status, attempts, max_attempts, run_at
)
SELECT tenant_id, queue, idempotency_key,
       jsonb_build_object('versionId', version_id), 'queued', 0, 5, now()
  FROM wanted
ON CONFLICT (tenant_id, queue, idempotency_key) DO UPDATE SET
  payload = EXCLUDED.payload,
  status = 'queued',
  attempts = 0,
  last_error = NULL,
  rerun_requested = false,
  run_at = EXCLUDED.run_at,
  max_attempts = EXCLUDED.max_attempts;
