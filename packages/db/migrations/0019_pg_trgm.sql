-- Custom SQL migration: trigram matching for entity names. Must run before the
-- placement tables, whose name index uses gin_trgm_ops.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
