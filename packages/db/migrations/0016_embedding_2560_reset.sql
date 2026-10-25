-- Custom data migration before the generated 2560 column change.
-- The old vectors cannot be widened from 1536 to 2560. They are derived data:
-- clear them, drop the old HNSW index, then let 0017 change the columns.
DROP INDEX IF EXISTS chunks_embedding_hnsw_idx;
--> statement-breakpoint
TRUNCATE TABLE chunks, embedding_cache;
