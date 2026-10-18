CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE chunks
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED;

CREATE INDEX chunks_tsv_gin_idx ON chunks USING GIN (tsv);
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding halfvec_cosine_ops);

-- Apply non-bypassable RLS to all Slice 1 tables
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'documents', 'pages', 'versions', 'version_contributors',
    'block_activity', 'chunks', 'embedding_cache', 'links'
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
