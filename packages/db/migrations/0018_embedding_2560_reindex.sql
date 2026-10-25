-- Custom data migration after the generated 2560 column change.
-- Recreate the HNSW index at the new width and rebuild the derived index from
-- the versions that were searchable before the migration. Each job is keyed
-- exactly like a normal index job, so an existing completed/dead-lettered row
-- is revived instead of duplicated.
CREATE INDEX "chunks_embedding_hnsw_idx"
  ON "chunks" USING hnsw ("embedding" halfvec_cosine_ops);
--> statement-breakpoint
WITH reindex AS (
  UPDATE versions
     SET status = 'indexing', error = NULL
   WHERE status = 'indexed'
  RETURNING tenant_id, id
)
INSERT INTO jobs (
  tenant_id, queue, idempotency_key, payload, status, attempts, max_attempts, run_at
)
SELECT tenant_id, 'version.index', 'index:' || id,
       jsonb_build_object('versionId', id), 'queued', 0, 5, now()
  FROM reindex
ON CONFLICT (tenant_id, queue, idempotency_key) DO UPDATE SET
  payload = EXCLUDED.payload,
  status = 'queued',
  attempts = 0,
  last_error = NULL,
  rerun_requested = false,
  run_at = EXCLUDED.run_at,
  max_attempts = EXCLUDED.max_attempts;
