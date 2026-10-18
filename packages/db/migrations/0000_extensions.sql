-- Custom SQL migration: extensions the schema depends on. Must run before
-- 0001_schema, which declares halfvec(1536) columns and HNSW indexes.
CREATE EXTENSION IF NOT EXISTS vector;
